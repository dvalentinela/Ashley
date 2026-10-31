import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, FIRST_JOB, OPERATOR, currentQuote, dispatchedJob, job, jobIdFrom, jpeg, laLocal, pdf, quoteForm, signIn } from "./helpers";

const one = <T,>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).first<T>();
const count = async (sql: string, ...p: unknown[]) => (await one<{ n: number }>(sql, ...p))!.n;

async function startedJob(cust: Client, op: Client) {
  const id = await dispatchedJob(cust, op);
  await op.ok(`/op/jobs/${id}/start`, { version: (await job(id))!.version });
  return id;
}

describe("M4 — FIRST TEST JOB (fictional print-and-deliver)", () => {
  it("request → quote $45 + $10 ceiling → approval → acceptance → $6.50 receipt → completion → invoice $51.50; partner 20% = $9", async () => {
    const op = await signIn(OPERATOR);
    await op.ok("/op/partners", { name: "Fourth Street Office (fictional)", login_email: "desk@fourth.test", share_percent: "20" });
    const partnerRow = await one<{ id: string; ref_code: string }>("SELECT id, ref_code FROM partners WHERE login_email = 'desk@fourth.test'");

    // The customer arrives through the partner's referral link.
    const cust = await signIn("fictional.customer@example.test");
    const r = await cust.get(`/r/${partnerRow!.ref_code}`);
    expect(r.headers.getSetCookie().join(";")).toContain("op_ref=");
    const id = jobIdFrom(await cust.ok("/c/jobs", { ...FIRST_JOB, files: pdf("customer-document.pdf") }));
    expect((await job(id))!.partner_id).toBe(partnerRow!.id);

    await op.ok("/op/availability", { start: laLocal(-1), end: laLocal(72), note: "pilot block" });
    await op.ok(`/op/jobs/${id}/quote`, quoteForm(1, { service_fee: "45", expense_ceiling: "10" }));
    const q = await currentQuote(id);
    await cust.ok(`/c/quotes/${q!.id}/approve`, { content_hash: q!.content_hash });
    await op.ok(`/op/jobs/${id}/accept`, { version: (await job(id))!.version, quote_id: q!.id });
    expect((await job(id))!.status).toBe("dispatched");
    await op.ok(`/op/jobs/${id}/start`, { version: (await job(id))!.version });

    // Expense with receipt: $6.50.
    await op.ok(`/op/jobs/${id}/expense`, { version: (await job(id))!.version, amount: "6.50", description: "Printing two sets (test receipt)", receipt: jpeg("receipt.jpg") });
    // Another $4.00 would exceed the $10 ceiling → refused, nothing recorded.
    const over = await op.post(`/op/jobs/${id}/expense`, { version: (await job(id))!.version, amount: "4.00", description: "extra", receipt: jpeg() });
    expect(over.status).toBe(422);
    expect(await over.text()).toContain("above the approved ceiling");
    // An expense without a receipt is refused.
    expect((await op.post(`/op/jobs/${id}/expense`, { version: (await job(id))!.version, amount: "1.00", description: "no receipt" })).status).toBe(422);
    expect(await count("SELECT COUNT(*) AS n FROM expenses WHERE job_id = ?", id)).toBe(1);

    // Completion requires evidence.
    const noEvidence = await op.post(`/op/jobs/${id}/complete`, { version: (await job(id))!.version, event_key: "k-none", summary: "Delivered", outcome: "completed" });
    expect(noEvidence.status).toBe(422);
    await op.ok(`/op/jobs/${id}/evidence`, { version: (await job(id))!.version, files: jpeg("handoff.jpg"), note: "Handed to front desk" });

    // Same completion event delivered twice → one completion, one invoice.
    const v = (await job(id))!.version;
    const form = { version: v, event_key: "completion-event-001", summary: "Two sets delivered to the reception desk; handoff photographed.", outcome: "completed" };
    const first = await op.ok(`/op/jobs/${id}/complete`, form);
    expect(first).toContain("ok=completed");
    const second = await op.ok(`/op/jobs/${id}/complete`, form);
    expect(second).toContain("ok=completed_duplicate");
    // A different completion event for the same job is refused.
    expect((await op.post(`/op/jobs/${id}/complete`, { ...form, event_key: "completion-event-002" })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM completions WHERE job_id = ?", id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM invoices WHERE job_id = ?", id)).toBe(1);

    // Draft invoice arithmetic, kept distinct from an issued invoice.
    const inv = await one<{ id: string; number: string; status: string; service_fee_cents: number; reimbursable_cents: number; tax_cents: number; total_cents: number; tax_label: string; is_test: number }>(
      "SELECT * FROM invoices WHERE job_id = ?",
      id,
    );
    expect(inv).toMatchObject({ status: "draft", service_fee_cents: 4500, reimbursable_cents: 650, tax_cents: 0, total_cents: 5150, is_test: 1 });
    expect(inv!.number).toMatch(/^TEST-INV-\d{5}$/);
    expect(inv!.tax_label).toContain("Tax not configured");
    const lines = (await env.DB.prepare("SELECT kind, amount_cents FROM invoice_lines WHERE invoice_id = ? ORDER BY sort").bind(inv!.id).all()).results;
    expect(lines).toEqual([
      { kind: "service", amount_cents: 4500 },
      { kind: "reimbursement", amount_cents: 650 },
      { kind: "tax", amount_cents: 0 },
    ]);
    const draftPage = await op.html(`/op/invoices/${inv!.id}`);
    expect(draftPage).toContain("DRAFT — NOT AN INVOICE");
    expect(draftPage).toContain("$51.50");
    // Customers never see drafts.
    expect((await cust.get(`/c/invoices/${inv!.id}`)).status).toBe(404);

    // Issue (twice → second refused).
    await op.ok(`/op/invoices/${inv!.id}/issue`, {});
    expect((await op.post(`/op/invoices/${inv!.id}/issue`, {})).status).toBe(409);
    expect((await job(id))!.status).toBe("invoiced");
    const issuedPage = await cust.html(`/c/invoices/${inv!.id}`);
    expect(issuedPage).toContain("TEST INVOICE");
    expect(issuedPage).toContain("$51.50");
    expect(issuedPage).toContain("No payment recorded");

    // Partner ledger: 20% of the $45 service fee, nothing on the $6.50 reimbursement; separate from the invoice.
    const ledger = (await env.DB.prepare("SELECT entry_type, basis_cents, rate_bps, amount_cents, status, policy_label FROM partner_ledger WHERE job_id = ?").bind(id).all()).results;
    expect(ledger).toEqual([{ entry_type: "accrual", basis_cents: 4500, rate_bps: 2000, amount_cents: 900, status: "pending_collection", policy_label: "TEST POLICY — not agreed commercial terms" }]);

    // Partner sees the referral and ledger, but not the invoice, customer, or files.
    const partner = await signIn("desk@fourth.test");
    const pv = await partner.html("/p");
    expect(pv).toContain((await job(id))!.ref as string);
    expect(pv).toContain("$9.00");
    expect(pv).not.toContain("fictional.customer@example.test");
    expect(pv).not.toContain("Reception desk, 100 Example Plaza");
    expect((await partner.get(`/c/invoices/${inv!.id}`)).status).toBe(403);
    const other = await signIn("other.customer@example.test");
    expect((await other.get(`/c/invoices/${inv!.id}`)).status).toBe(404);

    // Completion ≠ payment. Overpayment refused; manual confirmation marks paid; duplicate key ignored.
    expect((await op.post(`/op/invoices/${inv!.id}/payment`, { amount: "60.00", reference: "x", idempotency_key: "p-0" })).status).toBe(422);
    await op.ok(`/op/invoices/${inv!.id}/payment`, { amount: "51.50", reference: "TEST payment ref 0001", idempotency_key: "p-1" });
    const dup = await op.ok(`/op/invoices/${inv!.id}/payment`, { amount: "51.50", reference: "TEST payment ref 0001", idempotency_key: "p-1" });
    expect(dup).toContain("payment_duplicate");
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?", inv!.id)).toBe(1);
    expect((await job(id))!.status).toBe("paid");
    expect((await one<{ status: string }>("SELECT status FROM partner_ledger WHERE job_id = ?", id))!.status).toBe("earned");
    expect(await cust.html(`/c/invoices/${inv!.id}`)).toContain("TEST payment ref 0001");

    // Full audit trail for the job.
    const types = (await env.DB.prepare("SELECT type FROM job_events WHERE job_id = ? ORDER BY created_at, rowid").bind(id).all<{ type: string }>()).results.map((e) => e.type);
    for (const t of ["job.created", "quote.sent", "quote.approved", "assignment.accepted", "job.dispatched", "work.started", "expense.reported", "evidence.added", "job.completed", "invoice.issued", "payment.recorded_paid_in_full"]) {
      expect(types).toContain(t);
    }
  });

  it("corrections void the issued revision, create a new draft revision with the same number, and reverse the partner accrual", async () => {
    const op = await signIn(OPERATOR);
    await op.ok("/op/partners", { name: "Referrer B (fictional)", login_email: "", share_percent: "20" });
    const p = await one<{ id: string; ref_code: string }>("SELECT id, ref_code FROM partners WHERE name = 'Referrer B (fictional)'");
    const cust = await signIn("m4b@customer.test");
    await cust.get(`/r/${p!.ref_code}`);
    const id = await startedJob(cust, op);
    await op.ok(`/op/jobs/${id}/evidence`, { version: (await job(id))!.version, files: jpeg() });
    await op.ok(`/op/jobs/${id}/complete`, { version: (await job(id))!.version, event_key: "m4b-1", summary: "done", outcome: "completed" });
    const inv = await one<{ id: string; number: string }>("SELECT id, number FROM invoices WHERE job_id = ?", id);
    await op.ok(`/op/invoices/${inv!.id}/issue`, {});
    const loc = await op.ok(`/op/invoices/${inv!.id}/revise`, { reason: "Wrong description" });
    const rows = (await env.DB.prepare("SELECT number, revision, status FROM invoices WHERE job_id = ? ORDER BY revision").bind(id).all()).results;
    expect(rows).toEqual([
      { number: inv!.number, revision: 1, status: "void" },
      { number: inv!.number, revision: 2, status: "draft" },
    ]);
    expect(loc).toContain("/op/invoices/inv_");
    expect((await job(id))!.status).toBe("completed");
    const ledger = (await env.DB.prepare("SELECT entry_type, amount_cents, status FROM partner_ledger WHERE job_id = ? ORDER BY created_at, rowid").bind(id).all()).results;
    expect(ledger).toEqual([
      { entry_type: "accrual", amount_cents: 900, status: "reversed" },
      { entry_type: "reversal", amount_cents: -900, status: "reversed" },
    ]);
    const rev2 = await one<{ id: string }>("SELECT id FROM invoices WHERE job_id = ? AND revision = 2", id);
    await op.ok(`/op/invoices/${rev2!.id}/issue`, {});
    expect(await count("SELECT COUNT(*) AS n FROM partner_ledger WHERE job_id = ? AND entry_type = 'accrual' AND status = 'pending_collection'", id)).toBe(1);
    // Invoice numbers are unique across jobs.
    const numbers = (await env.DB.prepare("SELECT DISTINCT number, job_id FROM invoices").all<{ number: string; job_id: string }>()).results;
    expect(new Set(numbers.map((n) => n.number)).size).toBe(numbers.length);
  });

  it("an exception (recipient unavailable) stays visible until resolved", async () => {
    const op = await signIn(OPERATOR);
    const cust = await signIn("m4c@customer.test");
    const id = await startedJob(cust, op);
    await op.ok(`/op/jobs/${id}/issue`, { version: (await job(id))!.version, issue: "Reception desk closed at 11:05; nobody to sign." });
    expect((await job(id))!.status).toBe("blocked");
    expect(await op.html("/op")).toContain("Reception desk closed");
    // Completing with an exception requires describing the unresolved item.
    expect((await op.post(`/op/jobs/${id}/complete`, { version: (await job(id))!.version, event_key: "m4c-0", summary: "Returned documents", outcome: "completed_with_exception" })).status).toBe(422);
    await op.ok(`/op/jobs/${id}/complete`, { version: (await job(id))!.version, event_key: "m4c-1", summary: "Returned documents to customer", outcome: "completed_with_exception", unresolved_items: "Delivery not made" });
    const ref = (await job(id))!.ref as string;
    const queue = await op.html("/op");
    const blockedSection = queue.slice(queue.indexOf("Blocked / open exceptions"), queue.indexOf("Ready to invoice"));
    expect(blockedSection).toContain(ref);
    await op.ok(`/op/jobs/${id}/resolve-exception`, { note: "Customer will rebook" });
    const after = await op.html("/op");
    expect(after.slice(after.indexOf("Blocked / open exceptions"), after.indexOf("Ready to invoice"))).not.toContain(ref);
  });

  it("a customer can cancel before dispatch but not after", async () => {
    const op = await signIn(OPERATOR);
    const cust = await signIn("m4d@customer.test");
    const early = jobIdFrom(await cust.ok("/c/jobs", FIRST_JOB));
    await cust.ok(`/c/jobs/${early}/cancel`, { version: 1 });
    expect((await job(early))!.status).toBe("cancelled");
    const late = await dispatchedJob(cust, op);
    expect((await cust.post(`/c/jobs/${late}/cancel`, { version: (await job(late))!.version })).status).toBe(422);
  });
});
