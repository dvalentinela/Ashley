import type { Actor } from "../auth";
import { config, type Env } from "../env";
import { jobVersionGuard, newId, runBatch } from "../lib/db";
import { conflict, forbidden, invalid, notFound } from "../lib/errors";
import { text } from "../lib/format";
import { notificationInsert, operatorNotifications } from "../notify/outbox";
import { eventInsert, messageInsert, type EventActor } from "./events";
import { stageFiles } from "./files";

export type JobStatus =
  | "requested"
  | "needs_info"
  | "quoted"
  | "approved"
  | "dispatched"
  | "in_progress"
  | "blocked"
  | "completed"
  | "invoiced"
  | "paid"
  | "cancelled"
  | "declined";

export interface JobRow {
  id: string;
  ref: string;
  customer_id: string;
  partner_id: string | null;
  status: JobStatus;
  requested_outcome: string;
  instructions: string;
  contact_method: string;
  pickup_location: string;
  destination: string;
  destination_contact: string;
  requested_timing: string;
  limits: string;
  source: string;
  current_quote_id: string | null;
  blocked_reason: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface JobInput {
  requested_outcome: unknown;
  instructions?: unknown;
  contact_method: unknown;
  pickup_location?: unknown;
  destination?: unknown;
  destination_contact?: unknown;
  requested_timing?: unknown;
  limits?: unknown;
}

export const asEventActor = (a: Actor): EventActor => ({ userId: a.userId, role: a.role });

export function requireRole(actor: Actor | null, ...roles: Actor["role"][]): Actor {
  if (!actor) throw forbidden("Sign in first.");
  if (!roles.includes(actor.role)) throw forbidden();
  return actor;
}

async function nextSequence(db: D1Database, name: string): Promise<number> {
  const row = await db
    .prepare("INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value")
    .bind(name)
    .first<{ value: number }>();
  if (!row) throw new Error("sequence allocation failed");
  return row.value;
}

/** Customer submits a request. A request is not a booking. */
export async function createJob(
  env: Env,
  actor: Actor,
  input: JobInput,
  files: File[],
  referralCode: string | null,
): Promise<JobRow> {
  requireRole(actor, "customer");
  const now = Date.now();
  const fields = {
    requested_outcome: text(input.requested_outcome, "Requested outcome", { required: true, max: 2000 }),
    instructions: text(input.instructions, "Instructions", { max: 4000 }),
    contact_method: text(input.contact_method, "Contact method", { required: true, max: 300 }),
    pickup_location: text(input.pickup_location, "Pickup location", { max: 500 }),
    destination: text(input.destination, "Destination", { max: 500 }),
    destination_contact: text(input.destination_contact, "Destination contact", { max: 300 }),
    requested_timing: text(input.requested_timing, "Requested timing", { max: 500 }),
    limits: text(input.limits, "Limits", { max: 1000 }),
  };
  let partnerId: string | null = null;
  if (referralCode) {
    const p = await env.DB.prepare("SELECT id FROM partners WHERE ref_code = ?").bind(referralCode).first<{ id: string }>();
    partnerId = p?.id ?? null;
  }
  const id = newId("job");
  const ref = `J-${String(await nextSequence(env.DB, "job")).padStart(4, "0")}`;
  const staged = await stageFiles(env, id, "customer_material", files, actor.userId, now);
  const job: JobRow = {
    id,
    ref,
    customer_id: actor.userId,
    partner_id: partnerId,
    status: "requested",
    ...fields,
    source: partnerId ? "partner_referral" : "direct",
    current_quote_id: null,
    blocked_reason: null,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  try {
    await runBatch(env.DB, [
      env.DB.prepare(
        `INSERT INTO jobs (id, ref, customer_id, partner_id, status, requested_outcome, instructions, contact_method,
          pickup_location, destination, destination_contact, requested_timing, limits, source, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        id,
        ref,
        actor.userId,
        partnerId,
        fields.requested_outcome,
        fields.instructions,
        fields.contact_method,
        fields.pickup_location,
        fields.destination,
        fields.destination_contact,
        fields.requested_timing,
        fields.limits,
        job.source,
        now,
        now,
      ),
      ...staged.statements,
      eventInsert(
        env.DB,
        {
          jobId: id,
          actor: asEventActor(actor),
          type: "job.created",
          toStatus: "requested",
          jobVersion: 1,
          detail: { attachments: staged.rows.length, source: job.source },
          visibility: "customer",
        },
        now,
      ),
      ...operatorNotifications(
        env,
        {
          jobId: id,
          template: "operator.job_created",
          subject: `New request ${ref}`,
          body: `A new request (${ref}) needs review. Requested outcome: ${truncate(fields.requested_outcome, 140)}`,
          linkPath: `/op/jobs/${id}`,
          requiresAck: true,
          dedupeKey: `job.created:${id}`,
        },
        now,
      ),
    ]);
  } catch (err) {
    await staged.cleanup();
    throw err;
  }
  return job;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Loads a job the actor may see. Missing and forbidden both return 404. */
export async function getJobFor(env: Env, actor: Actor, jobId: string): Promise<JobRow> {
  let row: JobRow | null = null;
  if (actor.role === "operator") {
    row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
  } else if (actor.role === "customer") {
    row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND customer_id = ?").bind(jobId, actor.userId).first<JobRow>();
  }
  if (!row) throw notFound("Job not found");
  return row;
}

export async function listCustomerJobs(env: Env, actor: Actor): Promise<JobRow[]> {
  requireRole(actor, "customer");
  return (
    await env.DB.prepare("SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100").bind(actor.userId).all<JobRow>()
  ).results;
}

/** Applies a simple status change with optimistic concurrency and an audit event. */
export async function transition(
  env: Env,
  job: JobRow,
  actor: EventActor,
  to: JobStatus,
  type: string,
  extra: {
    statements?: D1PreparedStatement[];
    detail?: Record<string, unknown>;
    visibility?: "internal" | "customer";
    blockedReason?: string | null;
    refTable?: string;
    refId?: string;
  } = {},
): Promise<number> {
  const now = Date.now();
  const nextVersion = job.version + 1;
  await runBatch(env.DB, [
    jobVersionGuard(env.DB, job.id, job.version),
    env.DB.prepare("UPDATE jobs SET status = ?, version = ?, updated_at = ?, blocked_reason = ? WHERE id = ?").bind(
      to,
      nextVersion,
      now,
      extra.blockedReason === undefined ? job.blocked_reason : extra.blockedReason,
      job.id,
    ),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor,
        type,
        fromStatus: job.status,
        toStatus: to,
        jobVersion: nextVersion,
        detail: extra.detail,
        visibility: extra.visibility ?? "customer",
        refTable: extra.refTable,
        refId: extra.refId,
      },
      now,
    ),
    ...(extra.statements ?? []),
  ]);
  return nextVersion;
}

/** Bumps the version and records an event without changing status. */
export function touchJob(db: D1Database, job: JobRow, now = Date.now()): D1PreparedStatement[] {
  return [
    jobVersionGuard(db, job.id, job.version),
    db.prepare("UPDATE jobs SET version = ?, updated_at = ? WHERE id = ?").bind(job.version + 1, now, job.id),
  ];
}

export function assertVersion(job: JobRow, posted: unknown): void {
  const v = Number(posted);
  if (!Number.isInteger(v) || v !== job.version) {
    throw conflict("This job changed after the page was loaded, so nothing was saved. Reload the job and try again.");
  }
}

export async function customerEmail(env: Env, customerId: string): Promise<string> {
  const u = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(customerId).first<{ email: string }>();
  if (!u) throw new Error("customer missing");
  return u.email;
}

export async function customerNotification(
  env: Env,
  job: JobRow,
  template: string,
  subject: string,
  body: string,
  dedupeKey: string,
  linkPath = `/c/jobs/${job.id}`,
): Promise<D1PreparedStatement> {
  return notificationInsert(env.DB, {
    jobId: job.id,
    recipientUserId: job.customer_id,
    recipientEmail: await customerEmail(env, job.customer_id),
    template,
    subject,
    body,
    linkPath,
    dedupeKey,
  });
}

const CUSTOMER_REPLY_REOPENS: JobStatus[] = ["needs_info"];
const CLOSED: JobStatus[] = ["cancelled", "declined", "paid"];

/** A message on the job thread. Customer replies reopen a needs_info job. */
export async function postMessage(
  env: Env,
  actor: Actor,
  job: JobRow,
  body: unknown,
  opts: { visibility: "internal" | "customer"; postedVersion: unknown; kind?: "message" | "note" },
): Promise<void> {
  assertVersion(job, opts.postedVersion);
  const content = text(body, "Message", { required: true, max: 4000 });
  if (CLOSED.includes(job.status)) throw invalid("This job is closed. Start a new request instead.");
  const now = Date.now();
  const role = actor.role === "operator" ? "operator" : "customer";
  if (role === "customer" && opts.visibility !== "customer") throw forbidden();
  const msg = messageInsert(
    env.DB,
    { jobId: job.id, authorId: actor.userId, authorRole: role, kind: opts.kind ?? "message", visibility: opts.visibility, body: content },
    now,
  );
  const stmts: D1PreparedStatement[] = [msg.stmt];
  if (role === "customer") {
    stmts.push(
      ...operatorNotifications(env, {
        jobId: job.id,
        template: "operator.customer_message",
        subject: `Customer replied on ${job.ref}`,
        body: `The customer added a message to ${job.ref}.`,
        linkPath: `/op/jobs/${job.id}`,
        requiresAck: true,
        dedupeKey: `msg:${msg.id}`,
      }),
    );
  } else if (opts.visibility === "customer") {
    stmts.push(
      await customerNotification(env, job, "customer.message", `Update on ${job.ref}`, `There is a new message about your request ${job.ref}.`, `msg:${msg.id}`),
    );
  }
  if (role === "customer" && CUSTOMER_REPLY_REOPENS.includes(job.status)) {
    await transition(env, job, asEventActor(actor), "requested", "customer.replied", {
      statements: stmts,
      refTable: "job_messages",
      refId: msg.id,
    });
    return;
  }
  await runBatch(env.DB, [
    ...touchJob(env.DB, job, now),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: opts.visibility === "customer" ? "message.posted" : "note.added",
        jobVersion: job.version + 1,
        refTable: "job_messages",
        refId: msg.id,
        visibility: opts.visibility,
      },
      now,
    ),
    ...stmts,
  ]);
}

export async function requestInfo(env: Env, actor: Actor, job: JobRow, questions: unknown, postedVersion: unknown): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (!["requested", "needs_info"].includes(job.status)) throw invalid("Ask for information before a quote is sent.");
  const body = text(questions, "Questions", { required: true, max: 4000 });
  const msg = messageInsert(env.DB, { jobId: job.id, authorId: actor.userId, authorRole: "operator", kind: "message", visibility: "customer", body });
  await transition(env, job, asEventActor(actor), "needs_info", "info.requested", {
    refTable: "job_messages",
    refId: msg.id,
    statements: [
      msg.stmt,
      await customerNotification(env, job, "customer.info_requested", `Question about ${job.ref}`, `We need more information to quote ${job.ref}.`, `msg:${msg.id}`),
    ],
  });
}

export async function declineJob(env: Env, actor: Actor, job: JobRow, reason: unknown, postedVersion: unknown): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (!["requested", "needs_info", "quoted", "approved"].includes(job.status)) {
    throw invalid("Only jobs that have not been dispatched can be declined.");
  }
  const body = text(reason, "Reason", { required: true, max: 2000 });
  const msg = messageInsert(env.DB, { jobId: job.id, authorId: actor.userId, authorRole: "operator", kind: "message", visibility: "customer", body });
  await transition(env, job, asEventActor(actor), "declined", "job.declined", {
    refTable: "job_messages",
    refId: msg.id,
    statements: [
      msg.stmt,
      env.DB.prepare("UPDATE quotes SET status = 'withdrawn' WHERE job_id = ? AND status IN ('sent', 'approved')").bind(job.id),
      await customerNotification(env, job, "customer.declined", `Request ${job.ref} declined`, `We cannot take on request ${job.ref}.`, `declined:${job.id}`),
    ],
  });
}

export async function cancelJob(env: Env, actor: Actor, job: JobRow, postedVersion: unknown): Promise<void> {
  requireRole(actor, "customer");
  assertVersion(job, postedVersion);
  if (!["requested", "needs_info", "quoted", "approved"].includes(job.status)) {
    throw invalid("This job is already dispatched. Send a message to discuss cancellation terms.");
  }
  await transition(env, job, asEventActor(actor), "cancelled", "job.cancelled", {
    statements: [
      env.DB.prepare("UPDATE quotes SET status = 'withdrawn' WHERE job_id = ? AND status IN ('sent', 'approved')").bind(job.id),
      ...operatorNotifications(env, {
        jobId: job.id,
        template: "operator.cancelled",
        subject: `${job.ref} cancelled by customer`,
        body: `The customer cancelled ${job.ref} before dispatch.`,
        linkPath: `/op/jobs/${job.id}`,
        dedupeKey: `cancelled:${job.id}`,
      }),
    ],
  });
}

export interface MessageRow {
  id: string;
  author_role: string;
  kind: string;
  visibility: string;
  body: string;
  created_at: number;
}

export async function listMessages(db: D1Database, jobId: string, customerView: boolean): Promise<MessageRow[]> {
  const sql = customerView
    ? "SELECT * FROM job_messages WHERE job_id = ? AND visibility = 'customer' ORDER BY created_at, rowid"
    : "SELECT * FROM job_messages WHERE job_id = ? ORDER BY created_at, rowid";
  return (await db.prepare(sql).bind(jobId).all<MessageRow>()).results;
}

export type QJob = JobRow & {
  window_start: number | null;
  window_end: number | null;
  fee: number | null;
  ceiling: number | null;
  accepted: number | null;
  approved: number | null;
  quote_id: string | null;
  evidence_required: string | null;
  quote_status: string | null;
};

/** Operator queue. Buckets follow the brief's first operator screen. */
export async function operatorQueue(env: Env) {
  const db = env.DB;
  const cfg = config(env);
  const q = async <T>(sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all<T>()).results;
  const base = `SELECT j.*, q.window_start, q.window_end, q.service_fee_cents AS fee, q.expense_ceiling_cents AS ceiling,
      q.operator_accepted_at AS accepted, CASE WHEN q.status = 'approved' THEN q.customer_decision_at END AS approved,
      q.id AS quote_id, q.completion_evidence AS evidence_required, q.status AS quote_status
    FROM jobs j LEFT JOIN quotes q ON q.id = j.current_quote_id`;
  const placeholders = cfg.operatorEmails.map(() => "?").join(", ") || "''";
  return {
    needsDecision: await q<QJob>(`${base} WHERE j.status = 'requested' ORDER BY j.updated_at`),
    readyToAccept: await q<QJob>(`${base} WHERE j.status = 'approved' ORDER BY q.window_start`),
    inProgress: await q<QJob>(`${base} WHERE j.status IN ('dispatched', 'in_progress') ORDER BY q.window_start`),
    blocked: await q<QJob>(
      `${base} WHERE j.status = 'blocked'
         OR j.id IN (SELECT job_id FROM completions WHERE outcome = 'completed_with_exception' AND exception_resolved_at IS NULL)
       ORDER BY j.updated_at`,
    ),
    readyToInvoice: await q<QJob>(`${base} WHERE j.status = 'completed' ORDER BY j.updated_at`),
    waitingOnCustomer: await q<QJob>(`${base} WHERE j.status IN ('needs_info', 'quoted') ORDER BY j.updated_at`),
    unpaidInvoices: await q<{ id: string; number: string; revision: number; job_id: string; ref: string; total_cents: number; issued_at: number }>(
      `SELECT i.id, i.number, i.revision, i.job_id, j.ref, i.total_cents, i.issued_at FROM invoices i JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'issued' AND j.status = 'invoiced' ORDER BY i.issued_at`,
    ),
    unacknowledged: await q<{ id: string; job_id: string; ref: string; subject: string; status: string; created_at: number }>(
      `SELECT n.id, n.job_id, j.ref, n.subject, n.status, n.created_at FROM notifications n JOIN jobs j ON j.id = n.job_id
        WHERE n.requires_ack = 1 AND n.acknowledged_at IS NULL AND n.recipient_email IN (${placeholders})
        ORDER BY n.created_at`,
      ...cfg.operatorEmails,
    ),
    failedNotifications: await q<{ id: string; job_id: string | null; ref: string | null; subject: string; status: string; attempts: number; last_error: string | null; recipient_email: string }>(
      `SELECT n.id, n.job_id, j.ref, n.subject, n.status, n.attempts, n.last_error, n.recipient_email FROM notifications n
        LEFT JOIN jobs j ON j.id = n.job_id WHERE n.status IN ('failed', 'dead') ORDER BY n.created_at`,
    ),
    failedAgentRuns: await q<{ id: string; job_id: string; ref: string; status: string; last_error: string | null }>(
      `SELECT r.id, r.job_id, j.ref, r.status, r.last_error FROM agent_runs r JOIN jobs j ON j.id = r.job_id
        WHERE r.status IN ('failed', 'dead') AND r.created_at > ? ORDER BY r.created_at DESC LIMIT 20`,
      Date.now() - 7 * 24 * 3600_000,
    ),
  };
}

/** Partner view: only what a referral partner needs — no customer identity, contact, locations or files. */
export async function partnerReferrals(env: Env, actor: Actor) {
  requireRole(actor, "partner");
  if (!actor.partnerId) throw forbidden();
  const jobs = (
    await env.DB.prepare("SELECT id, ref, status, created_at, updated_at FROM jobs WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200")
      .bind(actor.partnerId)
      .all<{ id: string; ref: string; status: JobStatus; created_at: number; updated_at: number }>()
  ).results;
  const ledger = (
    await env.DB.prepare(
      `SELECT l.*, j.ref, i.number FROM partner_ledger l JOIN jobs j ON j.id = l.job_id JOIN invoices i ON i.id = l.invoice_id
        WHERE l.partner_id = ? ORDER BY l.created_at`,
    )
      .bind(actor.partnerId)
      .all<LedgerRow & { ref: string; number: string }>()
  ).results;
  const partner = await env.DB.prepare("SELECT name, ref_code, share_rate_bps, terms_status, policy_label FROM partners WHERE id = ?")
    .bind(actor.partnerId)
    .first<{ name: string; ref_code: string; share_rate_bps: number; terms_status: string; policy_label: string }>();
  return { jobs, ledger, partner };
}

export interface LedgerRow {
  id: string;
  partner_id: string;
  job_id: string;
  invoice_id: string;
  entry_type: "accrual" | "reversal";
  basis_cents: number;
  rate_bps: number;
  amount_cents: number;
  status: "pending_collection" | "earned" | "reversed";
  policy_label: string;
  created_at: number;
}
