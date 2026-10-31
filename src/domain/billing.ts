import type { Actor } from "../auth";
import { config, type Env } from "../env";
import { guard, jobVersionGuard, newId, runBatch } from "../lib/db";
import { conflict, invalid, notFound } from "../lib/errors";
import { formatMoney, parseMoney, text } from "../lib/format";
import { eventInsert } from "./events";
import { getQuote, listExpenses } from "./dispatch";
import { asEventActor, assertVersion, customerNotification, requireRole, type JobRow, type LedgerRow } from "./jobs";

export interface TaxConfig {
  mode: "unconfigured";
  label: string;
}

/**
 * Tax treatment is unresolved. Until it is decided and implemented, invoices
 * carry zero tax with an explicit label, and LIVE_MODE cannot be enabled.
 */
export function taxConfig(): TaxConfig {
  return { mode: "unconfigured", label: "Tax not configured — test invoice, not valid for real billing" };
}

export interface CompletionRow {
  id: string;
  job_id: string;
  quote_id: string;
  outcome: "completed" | "completed_with_exception";
  summary: string;
  unresolved_items: string;
  exception_resolved_at: number | null;
  confirmed_by: string;
  created_at: number;
  event_key: string;
}

export interface InvoiceRow {
  id: string;
  number: string;
  revision: number;
  job_id: string;
  customer_id: string;
  quote_id: string;
  status: "draft" | "issued" | "void";
  is_test: number;
  currency: string;
  service_fee_cents: number;
  reimbursable_cents: number;
  tax_cents: number;
  tax_label: string;
  total_cents: number;
  source_key: string;
  supersedes_id: string | null;
  created_at: number;
  issued_at: number | null;
  voided_at: number | null;
  void_reason: string | null;
}

export interface InvoiceLineRow {
  id: string;
  sort: number;
  kind: "service" | "reimbursement" | "tax";
  description: string;
  amount_cents: number;
  expense_id: string | null;
}

/** Statements that create a numbered draft invoice for the job's approved quote and documented expenses. */
async function draftInvoiceStatements(
  env: Env,
  job: JobRow,
  quoteId: string,
  sourceKey: string,
  createdBy: string,
  now: number,
  existingNumber?: { number: string; revision: number; supersedesId: string },
): Promise<{ invoiceId: string; statements: D1PreparedStatement[]; totals: { fee: number; reimb: number; tax: number; total: number } }> {
  const q = await getQuote(env.DB, quoteId);
  if (!q) throw new Error("quote missing");
  const expenses = (await listExpenses(env.DB, job.id)).filter((e) => e.quote_id === quoteId);
  const fee = q.service_fee_cents;
  const reimb = expenses.reduce((s, e) => s + e.amount_cents, 0);
  if (reimb > q.expense_ceiling_cents) throw invalid("Recorded expenses exceed the approved ceiling; resolve before invoicing.");
  const tax = taxConfig();
  const taxCents = 0;
  const total = fee + reimb + taxCents;
  const invoiceId = newId("inv");
  const isTest = config(env).liveMode ? 0 : 1;
  const statements: D1PreparedStatement[] = [];
  if (existingNumber) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO invoices (id, number, revision, job_id, customer_id, quote_id, status, is_test, service_fee_cents,
          reimbursable_cents, tax_cents, tax_label, total_cents, source_key, supersedes_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(invoiceId, existingNumber.number, existingNumber.revision, job.id, job.customer_id, quoteId, isTest, fee, reimb, taxCents, tax.label, total, sourceKey, existingNumber.supersedesId, now, createdBy),
    );
  } else {
    // The number is allocated inside the same transaction as the draft, so a
    // failed batch never consumes a number.
    statements.push(
      env.DB.prepare("INSERT INTO counters (name, value) VALUES ('invoice', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1"),
      env.DB.prepare(
        `INSERT INTO invoices (id, number, revision, job_id, customer_id, quote_id, status, is_test, service_fee_cents,
          reimbursable_cents, tax_cents, tax_label, total_cents, source_key, created_at, created_by)
         VALUES (?, (SELECT ? || printf('%05d', value) FROM counters WHERE name = 'invoice'), 1, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(invoiceId, isTest ? "TEST-INV-" : "INV-", job.id, job.customer_id, quoteId, isTest, fee, reimb, taxCents, tax.label, total, sourceKey, now, createdBy),
    );
  }
  let sort = 0;
  statements.push(
    env.DB.prepare("INSERT INTO invoice_lines (id, invoice_id, sort, kind, description, amount_cents) VALUES (?, ?, ?, 'service', ?, ?)").bind(
      newId("inl"),
      invoiceId,
      sort++,
      `Service fee — ${job.ref} (quote v${q.version}): ${q.scope.slice(0, 200)}`,
      fee,
    ),
  );
  for (const e of expenses) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO invoice_lines (id, invoice_id, sort, kind, description, amount_cents, expense_id) VALUES (?, ?, ?, 'reimbursement', ?, ?, ?)",
      ).bind(newId("inl"), invoiceId, sort++, `Reimbursed outside expense (receipt on file): ${e.description}`, e.amount_cents, e.id),
    );
  }
  statements.push(
    env.DB.prepare("INSERT INTO invoice_lines (id, invoice_id, sort, kind, description, amount_cents) VALUES (?, ?, ?, 'tax', ?, ?)").bind(
      newId("inl"),
      invoiceId,
      sort++,
      tax.label,
      taxCents,
    ),
  );
  return { invoiceId, statements, totals: { fee, reimb, tax: taxCents, total } };
}

/**
 * Operator confirms completion. Idempotent by event key: delivering the same
 * completion event again returns the original result and creates nothing.
 * A numbered draft invoice is created in the same transaction.
 */
export async function completeJob(
  env: Env,
  actor: Actor,
  job: JobRow,
  input: { summary: unknown; unresolved_items?: unknown; outcome: unknown; event_key: unknown },
  postedVersion: unknown,
): Promise<{ duplicate: boolean; completion: CompletionRow }> {
  requireRole(actor, "operator");
  const eventKey = text(input.event_key, "Event key", { required: true, max: 100 });
  const existing = await env.DB.prepare("SELECT * FROM completions WHERE event_key = ?").bind(eventKey).first<CompletionRow>();
  if (existing) {
    if (existing.job_id !== job.id) throw conflict("This completion key belongs to another job.");
    return { duplicate: true, completion: existing };
  }
  const already = await env.DB.prepare("SELECT * FROM completions WHERE job_id = ?").bind(job.id).first<CompletionRow>();
  if (already) throw conflict("This job is already completed. No second invoice was created.");
  assertVersion(job, postedVersion);
  if (job.status !== "in_progress" && job.status !== "blocked") throw invalid("Start the job before completing it.");
  const outcome = String(input.outcome) === "completed_with_exception" ? "completed_with_exception" : "completed";
  const summary = text(input.summary, "What happened", { required: true, max: 4000 });
  const unresolved = text(input.unresolved_items, "Unresolved items", { max: 2000 });
  if (outcome === "completed_with_exception" && !unresolved) throw invalid("Describe the unresolved item for an exception.");
  const evidenceCount =
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE job_id = ? AND kind = 'evidence'").bind(job.id).first<{ n: number }>())?.n ?? 0;
  if (outcome === "completed" && evidenceCount === 0) throw invalid("Add completion evidence (for example a handoff photo) before confirming completion.");
  const q = job.current_quote_id ? await getQuote(env.DB, job.current_quote_id) : null;
  if (!q || q.status !== "approved" || !q.operator_accepted_at) throw invalid("There is no approved and accepted quote for this job.");
  const now = Date.now();
  const completionId = newId("cmp");
  const draft = await draftInvoiceStatements(env, job, q.id, `completion:${job.id}`, actor.userId, now);
  await runBatch(env.DB, [
    jobVersionGuard(env.DB, job.id, job.version),
    env.DB.prepare("UPDATE jobs SET status = 'completed', blocked_reason = NULL, version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
    env.DB.prepare(
      `INSERT INTO completions (id, job_id, quote_id, outcome, summary, unresolved_items, confirmed_by, created_at, event_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(completionId, job.id, q.id, outcome, summary, unresolved, actor.userId, now, eventKey),
    ...draft.statements,
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: outcome === "completed" ? "job.completed" : "job.completed_with_exception",
        fromStatus: job.status,
        toStatus: "completed",
        jobVersion: job.version + 1,
        refTable: "completions",
        refId: completionId,
        detail: { summary, unresolved, evidence_files: evidenceCount, draft_invoice_id: draft.invoiceId, draft_total_cents: draft.totals.total },
        visibility: "customer",
      },
      now,
    ),
    await customerNotification(env, job, "customer.completed", `${job.ref} completed`, `The operator confirmed completion of ${job.ref}. ${outcome === "completed_with_exception" ? "There is an unresolved item; see the job page." : ""}`.trim(), `completed:${job.id}`),
  ]);
  const completion = (await env.DB.prepare("SELECT * FROM completions WHERE id = ?").bind(completionId).first<CompletionRow>())!;
  return { duplicate: false, completion };
}

export async function resolveException(env: Env, actor: Actor, job: JobRow, note: unknown): Promise<void> {
  requireRole(actor, "operator");
  const body = text(note, "Resolution", { required: true, max: 2000 });
  const c = await env.DB.prepare("SELECT * FROM completions WHERE job_id = ?").bind(job.id).first<CompletionRow>();
  if (!c || c.outcome !== "completed_with_exception" || c.exception_resolved_at) throw invalid("There is no open exception on this job.");
  const now = Date.now();
  await runBatch(env.DB, [
    guard(env.DB, "EXISTS (SELECT 1 FROM completions WHERE id = ? AND exception_resolved_at IS NULL)", c.id),
    env.DB.prepare("UPDATE completions SET exception_resolved_at = ?, exception_resolved_by = ? WHERE id = ?").bind(now, actor.userId, c.id),
    env.DB.prepare("UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
    eventInsert(env.DB, { jobId: job.id, actor: asEventActor(actor), type: "exception.resolved", jobVersion: job.version + 1, refTable: "completions", refId: c.id, detail: { note: body } }, now),
  ]);
}

export async function getInvoiceFor(env: Env, actor: Actor, invoiceId: string): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[]; job: JobRow; payments: PaymentRow[] }> {
  const invoice = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<InvoiceRow>();
  if (!invoice) throw notFound("Invoice not found");
  if (actor.role === "partner") throw notFound("Invoice not found");
  // Customers see only their own issued (or voided, for history) invoices, never drafts.
  if (actor.role === "customer" && (invoice.customer_id !== actor.userId || invoice.status === "draft")) throw notFound("Invoice not found");
  const job = (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(invoice.job_id).first<JobRow>())!;
  const lines = (await env.DB.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort").bind(invoice.id).all<InvoiceLineRow>()).results;
  const payments = await listPayments(env.DB, invoice.id);
  return { invoice, lines, job, payments };
}

export async function listInvoices(db: D1Database, jobId: string, customerView: boolean): Promise<InvoiceRow[]> {
  const sql = customerView
    ? "SELECT * FROM invoices WHERE job_id = ? AND status != 'draft' ORDER BY revision DESC"
    : "SELECT * FROM invoices WHERE job_id = ? ORDER BY revision DESC";
  return (await db.prepare(sql).bind(jobId).all<InvoiceRow>()).results;
}

function ledgerAccrual(db: D1Database, job: JobRow, invoice: InvoiceRow, partner: { id: string; share_rate_bps: number; policy_label: string }, now: number): D1PreparedStatement {
  const basis = invoice.service_fee_cents;
  const amount = Math.round((basis * partner.share_rate_bps) / 10_000);
  return db
    .prepare(
      `INSERT INTO partner_ledger (id, partner_id, job_id, invoice_id, entry_type, basis_cents, rate_bps, amount_cents, status,
        policy_label, source_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'accrual', ?, ?, ?, 'pending_collection', ?, ?, ?, ?)`,
    )
    .bind(newId("pld"), partner.id, job.id, invoice.id, basis, partner.share_rate_bps, amount, partner.policy_label, `accrual:${invoice.id}`, now, now);
}

/** Issues a draft. Issued invoices are immutable; corrections use voidAndRedraft. */
export async function issueInvoice(env: Env, actor: Actor, invoiceId: string): Promise<void> {
  requireRole(actor, "operator");
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<InvoiceRow>();
  if (!inv) throw notFound("Invoice not found");
  if (inv.status !== "draft") throw conflict("Only a draft can be issued. This invoice is already " + inv.status + ".");
  const job = (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(inv.job_id).first<JobRow>())!;
  if (job.status !== "completed") throw invalid("The job must be completed before invoicing.");
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    jobVersionGuard(env.DB, job.id, job.version),
    guard(env.DB, "EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'draft')", inv.id),
    env.DB.prepare("UPDATE invoices SET status = 'issued', issued_at = ?, issued_by = ? WHERE id = ?").bind(now, actor.userId, inv.id),
    env.DB.prepare("UPDATE jobs SET status = 'invoiced', version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: "invoice.issued",
        fromStatus: job.status,
        toStatus: "invoiced",
        jobVersion: job.version + 1,
        refTable: "invoices",
        refId: inv.id,
        detail: { number: inv.number, revision: inv.revision, total_cents: inv.total_cents, is_test: inv.is_test === 1 },
        visibility: "customer",
      },
      now,
    ),
    await customerNotification(
      env,
      job,
      "customer.invoice_issued",
      `${inv.is_test ? "TEST " : ""}Invoice ${inv.number} for ${job.ref}`,
      `${inv.is_test ? "This is a TEST invoice and not a request for payment. " : ""}Invoice ${inv.number} (revision ${inv.revision}) for ${job.ref}: total ${formatMoney(inv.total_cents)}.`,
      `invoice:${inv.id}`,
      `/c/invoices/${inv.id}`,
    ),
  ];
  if (job.partner_id) {
    const partner = await env.DB.prepare("SELECT id, share_rate_bps, policy_label FROM partners WHERE id = ?")
      .bind(job.partner_id)
      .first<{ id: string; share_rate_bps: number; policy_label: string }>();
    if (partner) stmts.push(ledgerAccrual(env.DB, job, inv, partner, now));
  }
  await runBatch(env.DB, stmts, "This invoice or job changed after the page was loaded. Reload and try again.");
}

/** Auditable correction: the issued revision becomes void and a new draft revision (same number) is created. */
export async function voidAndRedraft(env: Env, actor: Actor, invoiceId: string, reason: unknown): Promise<string> {
  requireRole(actor, "operator");
  const why = text(reason, "Reason", { required: true, max: 1000 });
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<InvoiceRow>();
  if (!inv || inv.status !== "issued") throw invalid("Only an issued invoice can be corrected.");
  const paid = (await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE invoice_id = ?").bind(inv.id).first<{ s: number }>())?.s ?? 0;
  if (paid > 0) throw invalid("A payment is recorded against this invoice. Refund/credit handling is not implemented yet.");
  const job = (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(inv.job_id).first<JobRow>())!;
  const now = Date.now();
  const redraft = await draftInvoiceStatements(env, job, inv.quote_id, `revision:${inv.id}`, actor.userId, now, {
    number: inv.number,
    revision: inv.revision + 1,
    supersedesId: inv.id,
  });
  await runBatch(env.DB, [
    jobVersionGuard(env.DB, job.id, job.version),
    guard(env.DB, "EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'issued')", inv.id),
    env.DB.prepare("UPDATE invoices SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?").bind(now, actor.userId, why, inv.id),
    env.DB.prepare(
      `INSERT INTO partner_ledger (id, partner_id, job_id, invoice_id, entry_type, basis_cents, rate_bps, amount_cents, status, policy_label, source_key, created_at, updated_at)
       SELECT ?, partner_id, job_id, invoice_id, 'reversal', -basis_cents, rate_bps, -amount_cents, 'reversed', policy_label, ?, ?, ?
         FROM partner_ledger WHERE invoice_id = ? AND entry_type = 'accrual'`,
    ).bind(newId("pld"), `reversal:${inv.id}`, now, now, inv.id),
    env.DB.prepare("UPDATE partner_ledger SET status = 'reversed', updated_at = ? WHERE invoice_id = ? AND entry_type = 'accrual'").bind(now, inv.id),
    ...redraft.statements,
    env.DB.prepare("UPDATE jobs SET status = 'completed', version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: "invoice.voided_for_revision",
        fromStatus: job.status,
        toStatus: "completed",
        jobVersion: job.version + 1,
        refTable: "invoices",
        refId: inv.id,
        detail: { number: inv.number, revision: inv.revision, reason: why, new_draft_id: redraft.invoiceId },
        visibility: "customer",
      },
      now,
    ),
  ]);
  return redraft.invoiceId;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  amount_cents: number;
  method: string;
  reference: string;
  is_test: number;
  recorded_by: string;
  created_at: number;
}

export async function listPayments(db: D1Database, invoiceId: string): Promise<PaymentRow[]> {
  return (await db.prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at").bind(invoiceId).all<PaymentRow>()).results;
}

/**
 * Records an operator's manual payment confirmation with a reference. Only
 * this (or, later, verified provider evidence) can mark an invoice paid.
 * Idempotent by key; cannot exceed the outstanding balance.
 */
export async function recordPayment(
  env: Env,
  actor: Actor,
  invoiceId: string,
  input: { amount: unknown; reference: unknown; idempotency_key: unknown },
): Promise<{ duplicate: boolean; paidInFull: boolean }> {
  requireRole(actor, "operator");
  const key = text(input.idempotency_key, "Idempotency key", { required: true, max: 100 });
  if (await env.DB.prepare("SELECT 1 FROM payments WHERE idempotency_key = ?").bind(key).first()) return { duplicate: true, paidInFull: false };
  const inv = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId).first<InvoiceRow>();
  if (!inv || inv.status !== "issued") throw invalid("Payments can be recorded only against an issued invoice.");
  const amount = parseMoney(input.amount, "Amount", { allowZero: false });
  const reference = text(input.reference, "Payment reference / evidence", { required: true, max: 500 });
  const paid = (await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE invoice_id = ?").bind(inv.id).first<{ s: number }>())?.s ?? 0;
  if (paid + amount > inv.total_cents) throw invalid(`That exceeds the outstanding balance of ${formatMoney(inv.total_cents - paid)}.`);
  const job = (await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(inv.job_id).first<JobRow>())!;
  const now = Date.now();
  const paymentId = newId("pay");
  const full = paid + amount === inv.total_cents;
  const stmts: D1PreparedStatement[] = [
    guard(env.DB, "(SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE invoice_id = ?) + ? <= ?", inv.id, amount, inv.total_cents),
    guard(env.DB, "EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'issued')", inv.id),
    env.DB.prepare(
      `INSERT INTO payments (id, invoice_id, amount_cents, method, reference, is_test, recorded_by, created_at, idempotency_key)
       VALUES (?, ?, ?, 'manual_confirmation', ?, ?, ?, ?, ?)`,
    ).bind(paymentId, inv.id, amount, reference, inv.is_test, actor.userId, now, key),
    env.DB.prepare("UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: full ? "payment.recorded_paid_in_full" : "payment.recorded_partial",
        fromStatus: job.status,
        toStatus: full ? "paid" : job.status,
        jobVersion: job.version + 1,
        refTable: "payments",
        refId: paymentId,
        detail: { amount_cents: amount, method: "manual_confirmation", reference, balance_cents: inv.total_cents - paid - amount },
        visibility: "customer",
      },
      now,
    ),
  ];
  if (full) {
    stmts.push(
      env.DB.prepare("UPDATE jobs SET status = 'paid' WHERE id = ?").bind(job.id),
      // Proposed policy: partner share is earned on collected service fees.
      env.DB.prepare("UPDATE partner_ledger SET status = 'earned', updated_at = ? WHERE invoice_id = ? AND entry_type = 'accrual' AND status = 'pending_collection'").bind(now, inv.id),
    );
  }
  await runBatch(env.DB, stmts, "The balance changed. Reload and try again.");
  return { duplicate: false, paidInFull: full };
}

export async function partnersWithLedger(env: Env) {
  const partners = (await env.DB.prepare("SELECT * FROM partners ORDER BY name").all<{ id: string; name: string; login_email: string | null; ref_code: string; share_rate_bps: number; terms_status: string; policy_label: string }>()).results;
  const ledger = (
    await env.DB.prepare(
      "SELECT l.*, j.ref, i.number, i.revision FROM partner_ledger l JOIN jobs j ON j.id = l.job_id JOIN invoices i ON i.id = l.invoice_id ORDER BY l.created_at",
    ).all<LedgerRow & { ref: string; number: string; revision: number }>()
  ).results;
  return { partners, ledger };
}

export async function createPartner(env: Env, actor: Actor, input: { name: unknown; login_email: unknown; share_percent: unknown }): Promise<void> {
  requireRole(actor, "operator");
  const name = text(input.name, "Name", { required: true, max: 200 });
  const email = text(input.login_email, "Partner sign-in email", { max: 254 }).toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("Enter a valid email or leave it blank");
  const pct = Number(String(input.share_percent ?? "0").trim() || "0");
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw invalid("Share percent must be between 0 and 100");
  const id = newId("ptn");
  const code = newId("ref").slice(4, 12);
  const now = Date.now();
  const stmts = [
    env.DB.prepare("INSERT INTO partners (id, name, login_email, ref_code, share_rate_bps, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      id,
      name,
      email,
      code,
      Math.round(pct * 100),
      now,
      actor.userId,
    ),
  ];
  if (email) {
    // If the partner already has an account, link it now; otherwise the
    // sign-up hook links it on first sign-in.
    stmts.push(env.DB.prepare(`UPDATE "user" SET role = 'partner', "partnerId" = ? WHERE lower(email) = ?`).bind(id, email));
  }
  await runBatch(env.DB, stmts);
}
