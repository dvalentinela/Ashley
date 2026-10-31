import type { Actor } from "../auth";
import { config, type Env } from "../env";
import { guard, jobVersionGuard, newId, runBatch, sha256Hex } from "../lib/db";
import { conflict, invalid, notFound } from "../lib/errors";
import { formatMoney, formatWindow, localToUtc, parseMoney, text } from "../lib/format";
import { operatorNotifications } from "../notify/outbox";
import { eventInsert, messageInsert } from "./events";
import { stageFiles } from "./files";
import { asEventActor, assertVersion, customerNotification, requireRole, transition, type JobRow, type JobStatus } from "./jobs";

export interface QuoteRow {
  id: string;
  job_id: string;
  version: number;
  scope: string;
  authorized_steps: string;
  service_fee_cents: number;
  expense_ceiling_cents: number;
  window_start: number;
  window_end: number;
  terms: string;
  required_authority: string;
  required_materials: string;
  completion_evidence: string;
  if_blocked: string;
  content_hash: string;
  status: "sent" | "approved" | "rejected" | "superseded" | "withdrawn";
  created_by: string;
  created_at: number;
  customer_decision_by: string | null;
  customer_decision_at: number | null;
  customer_decision_note: string | null;
  operator_accepted_by: string | null;
  operator_accepted_at: number | null;
}

export interface QuoteInput {
  scope: unknown;
  authorized_steps: unknown;
  service_fee: unknown;
  expense_ceiling: unknown;
  window_start: unknown;
  window_end: unknown;
  terms: unknown;
  required_authority?: unknown;
  required_materials?: unknown;
  completion_evidence?: unknown;
  if_blocked?: unknown;
}

const QUOTABLE: JobStatus[] = ["requested", "needs_info", "quoted", "approved", "dispatched", "in_progress", "blocked"];

export async function quoteHash(q: Omit<QuoteRow, "id" | "job_id" | "version" | "content_hash" | "status" | "created_by" | "created_at" | "customer_decision_by" | "customer_decision_at" | "customer_decision_note" | "operator_accepted_by" | "operator_accepted_at">): Promise<string> {
  const canonical = JSON.stringify([
    q.scope,
    q.authorized_steps,
    q.service_fee_cents,
    q.expense_ceiling_cents,
    q.window_start,
    q.window_end,
    q.terms,
    q.required_authority,
    q.required_materials,
    q.completion_evidence,
    q.if_blocked,
  ]);
  return sha256Hex(canonical);
}

export async function getQuote(db: D1Database, quoteId: string): Promise<QuoteRow | null> {
  return db.prepare("SELECT * FROM quotes WHERE id = ?").bind(quoteId).first<QuoteRow>();
}

export async function listQuotes(db: D1Database, jobId: string): Promise<QuoteRow[]> {
  return (await db.prepare("SELECT * FROM quotes WHERE job_id = ? ORDER BY version DESC").bind(jobId).all<QuoteRow>()).results;
}

export function stepsOf(q: Pick<QuoteRow, "authorized_steps">): string[] {
  try {
    const v = JSON.parse(q.authorized_steps);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Sends a new quote version. Any earlier open version is superseded, which
 * also voids its customer approval and operator acceptance. Revising an
 * active job pauses it until the new version is approved and accepted.
 */
export async function sendQuote(env: Env, actor: Actor, job: JobRow, input: QuoteInput, postedVersion: unknown): Promise<QuoteRow> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (!QUOTABLE.includes(job.status)) throw invalid(`A quote cannot be sent while the job is ${job.status}.`);
  const tz = config(env).timezone;
  const steps = text(input.authorized_steps, "Authorized steps", { required: true, max: 4000 })
    .split("\n")
    .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
  if (steps.length === 0) throw invalid("List at least one authorized step");
  const content = {
    scope: text(input.scope, "Scope", { required: true, max: 4000 }),
    authorized_steps: JSON.stringify(steps),
    service_fee_cents: parseMoney(input.service_fee, "Service fee"),
    expense_ceiling_cents: parseMoney(input.expense_ceiling, "Expense ceiling"),
    window_start: localToUtc(input.window_start, tz, "Window start"),
    window_end: localToUtc(input.window_end, tz, "Window end"),
    terms: text(input.terms, "Cancellation and exception terms", { required: true, max: 4000 }),
    required_authority: text(input.required_authority, "Required customer authority", { max: 2000 }),
    required_materials: text(input.required_materials, "Required materials", { max: 2000 }),
    completion_evidence: text(input.completion_evidence, "Completion evidence", { max: 2000 }),
    if_blocked: text(input.if_blocked, "What to do when blocked", { max: 2000 }),
  };
  if (content.window_end <= content.window_start) throw invalid("The window must end after it starts");
  if (content.window_end <= Date.now()) throw invalid("The window is already in the past");
  const now = Date.now();
  const id = newId("quo");
  const hash = await quoteHash(content);
  const version =
    ((await env.DB.prepare("SELECT MAX(version) AS v FROM quotes WHERE job_id = ?").bind(job.id).first<{ v: number | null }>())?.v ?? 0) + 1;
  const wasActive = ["dispatched", "in_progress", "blocked"].includes(job.status);
  await transition(env, job, asEventActor(actor), "quoted", wasActive ? "quote.revised_during_work" : "quote.sent", {
    refTable: "quotes",
    refId: id,
    detail: { version, service_fee_cents: content.service_fee_cents, expense_ceiling_cents: content.expense_ceiling_cents, content_hash: hash },
    statements: [
      env.DB.prepare("UPDATE quotes SET status = 'superseded' WHERE job_id = ? AND status IN ('sent', 'approved')").bind(job.id),
      env.DB.prepare(
        `INSERT INTO quotes (id, job_id, version, scope, authorized_steps, service_fee_cents, expense_ceiling_cents,
          window_start, window_end, terms, required_authority, required_materials, completion_evidence, if_blocked,
          content_hash, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`,
      ).bind(
        id,
        job.id,
        version,
        content.scope,
        content.authorized_steps,
        content.service_fee_cents,
        content.expense_ceiling_cents,
        content.window_start,
        content.window_end,
        content.terms,
        content.required_authority,
        content.required_materials,
        content.completion_evidence,
        content.if_blocked,
        hash,
        actor.userId,
        now,
      ),
      env.DB.prepare("UPDATE jobs SET current_quote_id = ? WHERE id = ?").bind(id, job.id),
      await customerNotification(
        env,
        job,
        "customer.quote_sent",
        `Quote ready for ${job.ref}`,
        `Quote version ${version} for ${job.ref}: service fee ${formatMoney(content.service_fee_cents)}, outside-expense ceiling ${formatMoney(content.expense_ceiling_cents)}, window ${formatWindow(content.window_start, content.window_end, tz)}. Review and approve or reject it in Operator.`,
        `quote:${id}`,
      ),
    ],
  });
  return (await getQuote(env.DB, id))!;
}

function workOrderContent(job: JobRow, q: QuoteRow) {
  return {
    job_id: job.id,
    job_ref: job.ref,
    quote_id: q.id,
    quote_version: q.version,
    customer_objective: job.requested_outcome,
    customer_instructions: job.instructions,
    scope: q.scope,
    authorized_steps: stepsOf(q),
    pickup: job.pickup_location,
    destination: job.destination,
    destination_contact: job.destination_contact,
    customer_contact_method: job.contact_method,
    time_window: { start: q.window_start, end: q.window_end },
    expense_limit_cents: q.expense_ceiling_cents,
    service_fee_cents: q.service_fee_cents,
    required_authority: q.required_authority,
    required_materials: q.required_materials,
    completion_evidence: q.completion_evidence,
    if_blocked: q.if_blocked,
    terms: q.terms,
  };
}

/** Statements that dispatch: status, work order (unique per quote), events, notices. */
async function dispatchStatements(env: Env, job: JobRow, q: QuoteRow, actor: Actor, now: number): Promise<D1PreparedStatement[]> {
  const woId = newId("wo");
  const tz = config(env).timezone;
  return [
    env.DB.prepare("UPDATE jobs SET status = 'dispatched' WHERE id = ?").bind(job.id),
    env.DB.prepare("INSERT INTO work_orders (id, job_id, quote_id, content, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      woId,
      job.id,
      q.id,
      JSON.stringify({ ...workOrderContent(job, q), generated_at: now }),
      now,
    ),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: "job.dispatched",
        fromStatus: job.status,
        toStatus: "dispatched",
        jobVersion: job.version + 1,
        refTable: "work_orders",
        refId: woId,
        detail: { quote_id: q.id, quote_version: q.version },
        visibility: "customer",
      },
      now,
    ),
    ...operatorNotifications(
      env,
      {
        jobId: job.id,
        template: "operator.dispatched",
        subject: `Dispatched: ${job.ref}`,
        body: `${job.ref} is dispatched for ${formatWindow(q.window_start, q.window_end, tz)}. Spending allowance ${formatMoney(q.expense_ceiling_cents)}. Open the work order to acknowledge.`,
        linkPath: `/op/jobs/${job.id}`,
        requiresAck: true,
        dedupeKey: `dispatch:${q.id}`,
      },
      now,
    ),
    await customerNotification(
      env,
      job,
      "customer.dispatched",
      `${job.ref} is scheduled`,
      `Your approved job ${job.ref} is scheduled for ${formatWindow(q.window_start, q.window_end, tz)}.`,
      `dispatch:${q.id}`,
    ),
  ];
}

/** Customer approves or rejects the exact quote version they were shown. */
export async function decideQuote(
  env: Env,
  actor: Actor,
  quoteId: string,
  decision: "approve" | "reject",
  postedHash: unknown,
  note: unknown,
): Promise<void> {
  requireRole(actor, "customer");
  const q = await getQuote(env.DB, quoteId);
  const job = q ? await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND customer_id = ?").bind(q.job_id, actor.userId).first<JobRow>() : null;
  if (!q || !job) throw notFound("Quote not found");
  if (q.status !== "sent" || job.current_quote_id !== q.id) {
    throw conflict("This quote is no longer the current version. Review the latest quote.");
  }
  if (String(postedHash ?? "") !== q.content_hash) throw conflict("The quote changed after you opened it. Review the current version.");
  const now = Date.now();
  const noteText = text(note, "Note", { max: 2000 });
  const tz = config(env).timezone;
  const base = [
    jobVersionGuard(env.DB, job.id, job.version),
    guard(env.DB, "EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status = 'sent' AND content_hash = ?)", q.id, q.content_hash),
    env.DB.prepare(
      `UPDATE quotes SET status = ?, customer_decision_by = ?, customer_decision_at = ?, customer_decision_note = ? WHERE id = ?`,
    ).bind(decision === "approve" ? "approved" : "rejected", actor.userId, now, noteText, q.id),
    env.DB.prepare("UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: decision === "approve" ? "quote.approved" : "quote.rejected",
        fromStatus: job.status,
        toStatus: decision === "reject" ? "requested" : q.operator_accepted_at ? "dispatched" : "approved",
        jobVersion: job.version + 1,
        refTable: "quotes",
        refId: q.id,
        detail: { quote_version: q.version, content_hash: q.content_hash, note: noteText },
        visibility: "customer",
      },
      now,
    ),
  ];
  if (decision === "reject") {
    await runBatch(env.DB, [
      ...base,
      env.DB.prepare("UPDATE jobs SET status = 'requested' WHERE id = ?").bind(job.id),
      ...operatorNotifications(env, {
        jobId: job.id,
        template: "operator.quote_rejected",
        subject: `Quote rejected: ${job.ref}`,
        body: `The customer rejected quote version ${q.version} for ${job.ref}. The job is not dispatched.`,
        linkPath: `/op/jobs/${job.id}`,
        requiresAck: true,
        dedupeKey: `quote.rejected:${q.id}`,
      }),
    ]);
    return;
  }
  if (now >= q.window_end) throw conflict("This quote's time window has passed. Ask for a revised quote.");
  if (q.operator_accepted_at) {
    // Operator already committed to this exact version: dispatch now.
    await runBatch(env.DB, [...base, ...(await dispatchStatements(env, job, q, actor, now))]);
    return;
  }
  await runBatch(env.DB, [
    ...base,
    env.DB.prepare("UPDATE jobs SET status = 'approved' WHERE id = ?").bind(job.id),
    ...operatorNotifications(env, {
      jobId: job.id,
      template: "operator.ready_to_accept",
      subject: `Ready to accept: ${job.ref}`,
      body: `The customer approved quote version ${q.version} for ${job.ref} (${formatWindow(q.window_start, q.window_end, tz)}). Accept it to dispatch.`,
      linkPath: `/op/jobs/${job.id}`,
      requiresAck: true,
      dedupeKey: `quote.approved:${q.id}`,
    }),
  ]);
}

export interface AvailabilityRow {
  id: string;
  starts_at: number;
  ends_at: number;
  note: string;
}

export async function listAvailability(db: D1Database, from = Date.now() - 24 * 3600_000): Promise<AvailabilityRow[]> {
  return (
    await db.prepare("SELECT id, starts_at, ends_at, note FROM availability WHERE deleted_at IS NULL AND ends_at > ? ORDER BY starts_at LIMIT 200")
      .bind(from)
      .all<AvailabilityRow>()
  ).results;
}

export async function addAvailability(env: Env, actor: Actor, start: unknown, end: unknown, note: unknown): Promise<void> {
  requireRole(actor, "operator");
  const tz = config(env).timezone;
  const s = localToUtc(start, tz, "Start");
  const e = localToUtc(end, tz, "End");
  if (e <= s) throw invalid("Availability must end after it starts");
  await env.DB.prepare("INSERT INTO availability (id, operator_id, starts_at, ends_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("avl"), actor.userId, s, e, text(note, "Note", { max: 300 }), Date.now())
    .run();
}

export async function removeAvailability(env: Env, actor: Actor, id: string): Promise<void> {
  requireRole(actor, "operator");
  await env.DB.prepare("UPDATE availability SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(Date.now(), id).run();
}

export async function windowIsAvailable(db: D1Database, start: number, end: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM availability WHERE deleted_at IS NULL AND starts_at <= ? AND ends_at >= ? LIMIT 1")
    .bind(start, end)
    .first();
  return Boolean(row);
}

/**
 * Operator accepts the current quote version. Requires the window to sit
 * inside declared availability; otherwise the job stays pending. If the
 * customer has already approved this version, the job is dispatched.
 */
export async function acceptAssignment(env: Env, actor: Actor, job: JobRow, quoteId: unknown, postedVersion: unknown): Promise<"dispatched" | "accepted"> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  const q = job.current_quote_id ? await getQuote(env.DB, job.current_quote_id) : null;
  if (!q || q.id !== String(quoteId ?? "")) throw conflict("The quote changed. Review the current version before accepting.");
  if (q.status !== "sent" && q.status !== "approved") throw invalid("There is no open quote to accept.");
  if (q.operator_accepted_at) throw conflict("You already accepted this quote version.");
  if (!(await windowIsAvailable(env.DB, q.window_start, q.window_end))) {
    throw invalid(
      "This window is outside your declared availability, so the job stays pending. Add availability that covers the window, or send a revised quote.",
    );
  }
  const now = Date.now();
  const base = [
    jobVersionGuard(env.DB, job.id, job.version),
    guard(env.DB, "EXISTS (SELECT 1 FROM quotes WHERE id = ? AND status = ? AND operator_accepted_at IS NULL)", q.id, q.status),
    guard(env.DB, "EXISTS (SELECT 1 FROM availability WHERE deleted_at IS NULL AND starts_at <= ? AND ends_at >= ?)", q.window_start, q.window_end),
    env.DB.prepare("UPDATE quotes SET operator_accepted_by = ?, operator_accepted_at = ? WHERE id = ?").bind(actor.userId, now, q.id),
    env.DB.prepare("UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
  ];
  if (q.status === "approved") {
    await runBatch(env.DB, [
      ...base,
      eventInsert(env.DB, { jobId: job.id, actor: asEventActor(actor), type: "assignment.accepted", jobVersion: job.version + 1, refTable: "quotes", refId: q.id, detail: { quote_version: q.version } }, now),
      ...(await dispatchStatements(env, job, { ...q, operator_accepted_at: now }, actor, now)),
    ]);
    return "dispatched";
  }
  await runBatch(env.DB, [
    ...base,
    eventInsert(
      env.DB,
      {
        jobId: job.id,
        actor: asEventActor(actor),
        type: "assignment.pre_accepted",
        jobVersion: job.version + 1,
        refTable: "quotes",
        refId: q.id,
        detail: { quote_version: q.version, note: "Dispatches automatically when the customer approves this exact version." },
      },
      now,
    ),
  ]);
  return "accepted";
}

export interface WorkOrderRow {
  id: string;
  job_id: string;
  quote_id: string;
  content: string;
  created_at: number;
}

export async function currentWorkOrder(db: D1Database, job: JobRow): Promise<WorkOrderRow | null> {
  if (!job.current_quote_id) return null;
  return db.prepare("SELECT * FROM work_orders WHERE quote_id = ?").bind(job.current_quote_id).first<WorkOrderRow>();
}

export async function startWork(env: Env, actor: Actor, job: JobRow, postedVersion: unknown): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (job.status !== "dispatched") throw invalid("Only a dispatched job can be started.");
  await transition(env, job, asEventActor(actor), "in_progress", "work.started");
}

export async function reportIssue(env: Env, actor: Actor, job: JobRow, issue: unknown, postedVersion: unknown): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (job.status !== "dispatched" && job.status !== "in_progress") throw invalid("Issues can be reported on dispatched or in-progress jobs.");
  const body = text(issue, "Issue", { required: true, max: 2000 });
  const msg = messageInsert(env.DB, { jobId: job.id, authorId: actor.userId, authorRole: "operator", kind: "issue", visibility: "internal", body });
  await transition(env, job, asEventActor(actor), "blocked", "work.blocked", {
    blockedReason: body,
    refTable: "job_messages",
    refId: msg.id,
    statements: [msg.stmt],
  });
}

export async function resolveIssue(env: Env, actor: Actor, job: JobRow, resolution: unknown, postedVersion: unknown): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (job.status !== "blocked") throw invalid("This job is not blocked.");
  const body = text(resolution, "Resolution", { required: true, max: 2000 });
  const msg = messageInsert(env.DB, { jobId: job.id, authorId: actor.userId, authorRole: "operator", kind: "resolution", visibility: "internal", body });
  await transition(env, job, asEventActor(actor), "in_progress", "work.unblocked", {
    blockedReason: null,
    refTable: "job_messages",
    refId: msg.id,
    statements: [msg.stmt],
  });
}

const FIELD_STATES: JobStatus[] = ["dispatched", "in_progress", "blocked"];

export interface ExpenseRow {
  id: string;
  job_id: string;
  quote_id: string;
  amount_cents: number;
  description: string;
  receipt_attachment_id: string;
  created_at: number;
}

export async function listExpenses(db: D1Database, jobId: string): Promise<ExpenseRow[]> {
  return (await db.prepare("SELECT * FROM expenses WHERE job_id = ? ORDER BY created_at").bind(jobId).all<ExpenseRow>()).results;
}

/**
 * Records an outside expense with its receipt. The running total may not
 * exceed the approved ceiling of the quote under which the work was
 * dispatched; anything more needs a revised quote approval.
 */
export async function reportExpense(
  env: Env,
  actor: Actor,
  job: JobRow,
  amount: unknown,
  description: unknown,
  receipts: File[],
  postedVersion: unknown,
): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (!FIELD_STATES.includes(job.status)) throw invalid("Expenses can be reported only while the job is dispatched or in progress.");
  const q = job.current_quote_id ? await getQuote(env.DB, job.current_quote_id) : null;
  if (!q || q.status !== "approved" || !q.operator_accepted_at) throw invalid("There is no approved and accepted quote for this job.");
  const cents = parseMoney(amount, "Amount", { allowZero: false });
  const desc = text(description, "Description", { required: true, max: 500 });
  if (receipts.length !== 1) throw invalid("Attach exactly one receipt photo or file for each expense.");
  const spent =
    (await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM expenses WHERE job_id = ? AND quote_id = ?").bind(job.id, q.id).first<{ s: number }>())
      ?.s ?? 0;
  if (spent + cents > q.expense_ceiling_cents) {
    throw invalid(
      `This would bring expenses to ${formatMoney(spent + cents)}, above the approved ceiling of ${formatMoney(q.expense_ceiling_cents)}. Do not spend more; send a revised quote for customer approval first.`,
    );
  }
  const now = Date.now();
  const staged = await stageFiles(env, job.id, "receipt", receipts, actor.userId, now);
  const expenseId = newId("exp");
  try {
    await runBatch(env.DB, [
      jobVersionGuard(env.DB, job.id, job.version),
      guard(
        env.DB,
        "(SELECT COALESCE(SUM(amount_cents), 0) FROM expenses WHERE job_id = ? AND quote_id = ?) + ? <= ?",
        job.id,
        q.id,
        cents,
        q.expense_ceiling_cents,
      ),
      env.DB.prepare("UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
      ...staged.statements,
      env.DB.prepare(
        `INSERT INTO expenses (id, job_id, quote_id, amount_cents, description, receipt_attachment_id, reported_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(expenseId, job.id, q.id, cents, desc, staged.rows[0]!.id, actor.userId, now),
      eventInsert(
        env.DB,
        {
          jobId: job.id,
          actor: asEventActor(actor),
          type: "expense.reported",
          jobVersion: job.version + 1,
          refTable: "expenses",
          refId: expenseId,
          detail: { amount_cents: cents, total_cents: spent + cents, ceiling_cents: q.expense_ceiling_cents },
          visibility: "customer",
        },
        now,
      ),
    ]);
  } catch (err) {
    await staged.cleanup();
    throw err;
  }
}

export async function uploadEvidence(env: Env, actor: Actor, job: JobRow, files: File[], note: unknown, postedVersion: unknown): Promise<void> {
  requireRole(actor, "operator");
  assertVersion(job, postedVersion);
  if (!FIELD_STATES.includes(job.status)) throw invalid("Evidence can be added while the job is dispatched, in progress or blocked.");
  if (files.length === 0) throw invalid("Choose at least one photo or file.");
  const now = Date.now();
  const staged = await stageFiles(env, job.id, "evidence", files, actor.userId, now);
  const noteText = text(note, "Note", { max: 1000 });
  try {
    await runBatch(env.DB, [
      jobVersionGuard(env.DB, job.id, job.version),
      env.DB.prepare("UPDATE jobs SET version = version + 1, updated_at = ? WHERE id = ?").bind(now, job.id),
      ...staged.statements,
      eventInsert(
        env.DB,
        {
          jobId: job.id,
          actor: asEventActor(actor),
          type: "evidence.added",
          jobVersion: job.version + 1,
          detail: { files: staged.rows.map((r) => r.id), note: noteText },
          visibility: "customer",
        },
        now,
      ),
    ]);
  } catch (err) {
    await staged.cleanup();
    throw err;
  }
}
