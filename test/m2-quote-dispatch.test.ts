import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EmailError, sendViaResend } from "../src/notify/email";
import { FIRST_JOB, OPERATOR, currentQuote, dispatchedJob, drain, job, jobIdFrom, laLocal, pdf, quoteForm, signIn } from "./helpers";

const count = async (sql: string, ...p: unknown[]) => (await env.DB.prepare(sql).bind(...p).first<{ n: number }>())!.n;

describe("M2 — quote, approval and human dispatch", () => {
  it("dispatches only with customer approval of the exact version AND operator acceptance; creates one work order", async () => {
    const cust = await signIn("m2a@customer.test");
    const op = await signIn(OPERATOR);
    const id = await dispatchedJob(cust, op);
    const j = await job(id);
    expect(j!.status).toBe("dispatched");
    const q = await currentQuote(id);
    expect(q!.status).toBe("approved");
    expect(await count("SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?", id)).toBe(1);
    const wo = await env.DB.prepare("SELECT content FROM work_orders WHERE job_id = ?").bind(id).first<{ content: string }>();
    const content = JSON.parse(wo!.content);
    expect(content).toMatchObject({ job_ref: j!.ref, expense_limit_cents: 1000, service_fee_cents: 4500, completion_evidence: "Photo of handoff and print receipt" });
    expect(content.authorized_steps).toHaveLength(3);

    // Duplicate accept (e.g. double tap / replayed request) cannot create a second assignment.
    const again = await op.post(`/op/jobs/${id}/accept`, { version: j!.version, quote_id: q!.id });
    expect(again.status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?", id)).toBe(1);

    // Audit trail: actor, time and supporting record for each consequential change.
    const events = (await env.DB.prepare("SELECT type, actor_role, actor_id, ref_table FROM job_events WHERE job_id = ? ORDER BY created_at, rowid").bind(id).all()).results;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["job.created", "quote.sent", "quote.approved", "assignment.accepted", "job.dispatched"]));
    for (const e of events) expect(e.actor_id).toBeTruthy();
    expect(events.find((e) => e.type === "job.dispatched")!.ref_table).toBe("work_orders");

    // The dispatch card shows on the operator queue with the right actions.
    const queue = await op.html("/op");
    expect(queue).toContain(j!.ref as string);
    expect(queue).toContain("Customer approved");
    expect(queue).toContain(`/op/jobs/${id}/start`);
  });

  it("a rejected quote never dispatches", async () => {
    const cust = await signIn("m2b@customer.test");
    const op = await signIn(OPERATOR);
    const id = jobIdFrom(await cust.ok("/c/jobs", { ...FIRST_JOB, files: pdf() }));
    await op.ok("/op/availability", { start: laLocal(-1), end: laLocal(72) });
    await op.ok(`/op/jobs/${id}/quote`, quoteForm(1));
    const q = await currentQuote(id);
    // Operator pre-accepts; rejection must still prevent dispatch.
    await op.ok(`/op/jobs/${id}/accept`, { version: (await job(id))!.version, quote_id: q!.id });
    await cust.ok(`/c/quotes/${q!.id}/reject`, { content_hash: q!.content_hash, note: "Too expensive" });
    expect((await job(id))!.status).toBe("requested");
    expect(await count("SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?", id)).toBe(0);
    // Approving the rejected version afterwards is refused.
    expect((await cust.post(`/c/quotes/${q!.id}/approve`, { content_hash: q!.content_hash })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?", id)).toBe(0);
  });

  it("a changed quote voids the earlier approval; approval of a stale version is refused", async () => {
    const cust = await signIn("m2c@customer.test");
    const op = await signIn(OPERATOR);
    const id = jobIdFrom(await cust.ok("/c/jobs", FIRST_JOB));
    await op.ok("/op/availability", { start: laLocal(-1), end: laLocal(72) });
    await op.ok(`/op/jobs/${id}/quote`, quoteForm(1));
    const v1 = await currentQuote(id);
    // Operator revises before the customer decides.
    await op.ok(`/op/jobs/${id}/quote`, quoteForm((await job(id))!.version, { service_fee: "60.00" }));
    const v2 = await currentQuote(id);
    expect(v2!.version).toBe(2);
    expect((await cust.post(`/c/quotes/${v1!.id}/approve`, { content_hash: v1!.content_hash })).status).toBe(409);
    // Tampered hash for the current version is refused too.
    expect((await cust.post(`/c/quotes/${v2!.id}/approve`, { content_hash: "0".repeat(64) })).status).toBe(409);
    expect((await job(id))!.status).toBe("quoted");

    // Approve v2, dispatch, then a mid-job revision pauses work until re-approved.
    await cust.ok(`/c/quotes/${v2!.id}/approve`, { content_hash: v2!.content_hash });
    await op.ok(`/op/jobs/${id}/accept`, { version: (await job(id))!.version, quote_id: v2!.id });
    expect((await job(id))!.status).toBe("dispatched");
    await op.ok(`/op/jobs/${id}/quote`, quoteForm((await job(id))!.version, { expense_ceiling: "25.00" }));
    expect((await job(id))!.status).toBe("quoted");
    const v3 = await currentQuote(id);
    expect(v3!.version).toBe(3);
    expect((await env.DB.prepare("SELECT status FROM quotes WHERE id = ?").bind(v2!.id).first<{ status: string }>())!.status).toBe("superseded");
    // Field actions are refused while the revision is pending.
    expect((await op.post(`/op/jobs/${id}/start`, { version: (await job(id))!.version })).status).toBe(422);
  });

  it("a request outside the operator's declared availability stays pending", async () => {
    const cust = await signIn("m2d@customer.test");
    const op = await signIn(OPERATOR);
    const id = jobIdFrom(await cust.ok("/c/jobs", FIRST_JOB));
    // Window 10 days out; no availability covers it.
    await op.ok(`/op/jobs/${id}/quote`, quoteForm(1, { window_start: laLocal(240), window_end: laLocal(242) }));
    const q = await currentQuote(id);
    await cust.ok(`/c/quotes/${q!.id}/approve`, { content_hash: q!.content_hash });
    expect((await job(id))!.status).toBe("approved");
    const res = await op.post(`/op/jobs/${id}/accept`, { version: (await job(id))!.version, quote_id: q!.id });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("outside your declared availability");
    expect((await job(id))!.status).toBe("approved");
    expect(await count("SELECT COUNT(*) AS n FROM work_orders WHERE job_id = ?", id)).toBe(0);
    expect(await op.html("/op")).toContain("Outside your declared availability");
    // Adding covering availability lets the operator accept.
    await op.ok("/op/availability", { start: laLocal(239), end: laLocal(244) });
    await op.ok(`/op/jobs/${id}/accept`, { version: (await job(id))!.version, quote_id: q!.id });
    expect((await job(id))!.status).toBe("dispatched");
  });
});

describe("M2 — notifications", () => {
  it("delivers through the outbox, leads to the right job, and shows unacknowledged items until opened", async () => {
    const cust = await signIn("m2e@customer.test");
    const op = await signIn(OPERATOR);
    const id = await dispatchedJob(cust, op);
    const pending = await count("SELECT COUNT(*) AS n FROM notifications WHERE job_id = ? AND status = 'pending'", id);
    expect(pending).toBeGreaterThan(0);
    await drain();
    // In tests the dev provider records messages as 'simulated' — never 'sent'.
    expect(await count("SELECT COUNT(*) AS n FROM notifications WHERE job_id = ? AND status = 'sent'", id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM notifications WHERE job_id = ? AND status = 'simulated'", id)).toBe(pending);
    const dispatchMail = await env.DB.prepare("SELECT body_text FROM dev_mailbox WHERE recipient = ? AND subject LIKE 'Dispatched:%' ORDER BY created_at DESC LIMIT 1")
      .bind(OPERATOR)
      .first<{ body_text: string }>();
    expect(dispatchMail!.body_text).toContain(`http://localhost/op/jobs/${id}`);

    // Unacknowledged until the operator opens the job.
    const ref = (await job(id))!.ref as string;
    const before = await op.html("/op");
    expect(before).toMatch(/Unacknowledged \(\d+\)/);
    expect(before).toContain(`Dispatched: ${ref}`);
    await op.html(`/op/jobs/${id}`);
    expect(await count("SELECT COUNT(*) AS n FROM notifications WHERE job_id = ? AND requires_ack = 1 AND acknowledged_at IS NULL AND recipient_email = ?", id, OPERATOR)).toBe(0);
    expect(await op.html("/op")).not.toContain(`Dispatched: ${ref}`);
  });

  it("retries failed delivery with backoff, gives up visibly, keeps the job in the queue, and supports manual retry", async () => {
    // A sign-in email that cannot be delivered gives a clear error, not a fake success.
    const { Client } = await import("./helpers");
    const failed = await new Client().post("/login", { email: "someone@fail.test" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("could not be sent");

    // Customer signs in, then their address starts failing (e.g. a full mailbox).
    const cust = await signIn("m2f@customer.test");
    await env.DB.prepare('UPDATE "user" SET email = ? WHERE email = ?').bind("someone@fail.test", "m2f@customer.test").run();
    const op = await signIn(OPERATOR);
    const id = jobIdFrom(await cust.ok("/c/jobs", FIRST_JOB));
    await op.ok(`/op/jobs/${id}/quote`, quoteForm(1));
    const n = await env.DB.prepare("SELECT id FROM notifications WHERE job_id = ? AND recipient_email = 'someone@fail.test'").bind(id).first<{ id: string }>();
    let t = Date.now();
    await drain(t);
    let row = await env.DB.prepare("SELECT status, attempts, next_attempt_at, last_error FROM notifications WHERE id = ?").bind(n!.id).first<{ status: string; attempts: number; next_attempt_at: number; last_error: string }>();
    expect(row).toMatchObject({ status: "failed", attempts: 1 });
    expect(row!.last_error).toContain("Simulated delivery failure");
    expect(row!.next_attempt_at).toBeGreaterThan(t);
    // Not retried before the backoff elapses.
    await drain(t + 1000);
    expect((await env.DB.prepare("SELECT attempts FROM notifications WHERE id = ?").bind(n!.id).first<{ attempts: number }>())!.attempts).toBe(1);
    for (let i = 0; i < 6; i++) {
      t += 2 * 3600_000;
      await drain(t);
    }
    row = await env.DB.prepare("SELECT status, attempts FROM notifications WHERE id = ?").bind(n!.id).first();
    expect(row).toMatchObject({ status: "dead", attempts: 5 });
    // The job is still in the operator queue and the failure is listed.
    const queue = await op.html("/op");
    expect(queue).toContain("Failed notifications");
    expect(queue).toContain((await job(id))!.ref as string);
    // Manual retry re-queues it with more attempts.
    await op.ok(`/op/notifications/${n!.id}/retry`, {});
    expect((await env.DB.prepare("SELECT status, max_attempts FROM notifications WHERE id = ?").bind(n!.id).first())).toMatchObject({ status: "pending", max_attempts: 8 });
    expect(await count("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'notification.retry_requested'", id)).toBe(1);
  });

  it("Resend adapter sends the documented request with an idempotency key and classifies errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = await sendViaResend("re_test", "Operator <ops@example.test>", { to: "a@b.test", subject: "S", text: "T", idempotencyKey: "ntf:1" }, async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    });
    expect(ok).toEqual({ status: "sent", provider: "resend", providerMessageId: "email_123" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("authorization")).toBe("Bearer re_test");
    expect(h.get("idempotency-key")).toBe("ntf:1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: "Operator <ops@example.test>", to: ["a@b.test"], subject: "S", text: "T" });

    const err429 = await sendViaResend("k", "f", { to: "a@b.test", subject: "", text: "", idempotencyKey: "x" }, async () => new Response("rate", { status: 429 })).catch((e) => e);
    expect(err429).toBeInstanceOf(EmailError);
    expect(err429.retryable).toBe(true);
    const err403 = await sendViaResend("k", "f", { to: "a@b.test", subject: "", text: "", idempotencyKey: "x" }, async () => new Response("domain not verified", { status: 403 })).catch((e) => e);
    expect(err403.retryable).toBe(false);
  });
});
