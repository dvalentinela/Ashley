import { Hono } from "hono";
import type { Actor } from "../auth";
import { agentStatus, approveAction, latestQuoteDraft, listRuns, rejectAction, requestPlan, type ActionView, type RunView } from "../agent/runtime";
import { kick } from "../background";
import { completeJob, createPartner, getInvoiceFor, issueInvoice, listInvoices, partnersWithLedger, recordPayment, resolveException, voidAndRedraft, type CompletionRow } from "../domain/billing";
import {
  acceptAssignment,
  addAvailability,
  currentWorkOrder,
  getQuote,
  listAvailability,
  listExpenses,
  listQuotes,
  removeAvailability,
  reportExpense,
  reportIssue,
  resolveIssue,
  sendQuote,
  startWork,
  stepsOf,
  uploadEvidence,
  windowIsAvailable,
  type QuoteRow,
} from "../domain/dispatch";
import { eventInsert, listEvents } from "../domain/events";
import { listAttachments, pickFiles } from "../domain/files";
import { declineJob, getJobFor, listMessages, operatorQueue, postMessage, requestInfo, requireRole, type JobRow, type QJob } from "../domain/jobs";
import { config, type Env } from "../env";
import { notFound } from "../lib/errors";
import { formatMoney, formatTime, formatWindow, utcToLocalInput } from "../lib/format";
import { acknowledgeJobNotifications, retryNotification } from "../notify/outbox";
import { InvoiceView, WorkOrderView, type WorkOrderContent } from "./shared";
import { ActionForm, Field, Layout, MoneyField, Section, Status, Yes } from "./ui";

type C = { Bindings: Env; Variables: { actor: Actor | null } };
export const operator = new Hono<C>();

operator.use("*", async (c, next) => {
  requireRole(c.get("actor"), "operator");
  await next();
});

function nextAction(job: Pick<JobRow, "status">, opts: { accepted?: boolean; available?: boolean } = {}): string {
  switch (job.status) {
    case "requested":
      return "Review: ask for information, ask Catherine for a plan, send a quote, or decline.";
    case "needs_info":
      return "Waiting for the customer's answer.";
    case "quoted":
      return opts.accepted ? "You pre-accepted. Waiting for the customer to approve this exact version." : "Waiting for customer approval. You may pre-accept if the window fits your availability.";
    case "approved":
      return opts.available === false ? "Outside your declared availability — add availability covering the window or send a revised quote." : "Accept to dispatch.";
    case "dispatched":
      return "Start the job when you begin the work.";
    case "in_progress":
      return "Do the authorized steps; add evidence and receipts; then complete.";
    case "blocked":
      return "Resolve the issue, or complete with an exception.";
    case "completed":
      return "Review and issue the draft invoice.";
    case "invoiced":
      return "Record payment when verified payment is received.";
    default:
      return "No action needed.";
  }
}

const DispatchCard = ({ j, tz, available }: { j: QJob; tz: string; available?: boolean }) => (
  <div class="qcard">
    <h3>
      <a href={`/op/jobs/${j.id}`}>{j.ref}</a> <Status status={j.status} />
    </h3>
    <div>{j.requested_outcome}</div>
    <div class="row">
      <Yes ok={Boolean(j.approved)} yes="Customer approved" no="No customer approval" />
      <Yes ok={Boolean(j.accepted)} yes="Operator accepted" no="Not accepted" />
    </div>
    <p>
      <strong>Next:</strong> {nextAction(j, { accepted: Boolean(j.accepted), available })}
    </p>
    {j.blocked_reason && <p class="flash err">Blocked: {j.blocked_reason}</p>}
    <dl class="kv">
      <dt>Where</dt>
      <dd>
        {j.pickup_location || "—"} → {j.destination || "—"}
      </dd>
      <dt>Contact</dt>
      <dd>{j.destination_contact || j.contact_method}</dd>
      <dt>When</dt>
      <dd>{j.window_start && j.window_end ? formatWindow(j.window_start, j.window_end, tz) : j.requested_timing || "—"}</dd>
      <dt>Spending allowance</dt>
      <dd>{j.ceiling !== null ? formatMoney(j.ceiling) : "—"}</dd>
      <dt>Evidence required</dt>
      <dd>{j.evidence_required || "—"}</dd>
    </dl>
    <div class="row">
      {j.status === "approved" && j.quote_id && !j.accepted && available !== false && (
        <ActionForm action={`/op/jobs/${j.id}/accept`} version={j.version} class="inline">
          <input type="hidden" name="quote_id" value={j.quote_id} />
          <button type="submit">Accept</button>
        </ActionForm>
      )}
      {j.status === "dispatched" && (
        <ActionForm action={`/op/jobs/${j.id}/start`} version={j.version} class="inline">
          <button type="submit">Start</button>
        </ActionForm>
      )}
      {(j.status === "dispatched" || j.status === "in_progress") && (
        <a class="btn secondary" href={`/op/jobs/${j.id}#field`}>
          Report issue
        </a>
      )}
      {(j.status === "in_progress" || j.status === "blocked") && (
        <a class="btn secondary" href={`/op/jobs/${j.id}#complete`}>
          Complete
        </a>
      )}
    </div>
  </div>
);

operator.get("/", async (c) => {
  const actor = c.get("actor")!;
  const tz = config(c.env).timezone;
  const q = await operatorQueue(c.env);
  const availability = new Map<string, boolean>();
  for (const j of q.readyToAccept) {
    if (j.window_start && j.window_end) availability.set(j.id, await windowIsAvailable(c.env.DB, j.window_start, j.window_end));
  }
  const ai = await agentStatus(c.env);
  const bucket = (title: string, jobs: QJob[]) => (
    <div class="bucket">
      <h2>
        {title} <span class="count">({jobs.length})</span>
      </h2>
      {jobs.length === 0 ? <p class="muted">None.</p> : jobs.map((j) => <DispatchCard j={j} tz={tz} available={availability.get(j.id)} />)}
    </div>
  );
  return c.html(
    <Layout title="Queue" actor={actor} flash={c.req.query("ok")}>
      <h1>Operator queue</h1>
      {!ai.available && <p class="flash err">Catherine unavailable: {ai.reason} Manual review works normally.</p>}
      {q.failedNotifications.length > 0 && (
        <Section title={`Failed notifications (${q.failedNotifications.length})`} note="These were not delivered. The jobs stay in the queue regardless.">
          <ul class="plain">
            {q.failedNotifications.map((n) => (
              <li>
                <strong>{n.status === "dead" ? "Gave up" : "Retrying"}</strong> — {n.subject} to {n.recipient_email} · attempts {n.attempts}
                <small>{n.last_error}</small>
                <div class="row">
                  {n.job_id && <a href={`/op/jobs/${n.job_id}`}>{n.ref}</a>}
                  <ActionForm action={`/op/notifications/${n.id}/retry`} class="inline">
                    <button type="submit" class="secondary">
                      Retry now
                    </button>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {q.unacknowledged.length > 0 && (
        <Section title={`Unacknowledged (${q.unacknowledged.length})`} note="Opening the job acknowledges its notifications.">
          <ul class="plain">
            {q.unacknowledged.map((n) => (
              <li>
                <a href={`/op/jobs/${n.job_id}`}>{n.ref}</a> — {n.subject} <small>{formatTime(n.created_at, tz)} · delivery {n.status}</small>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {bucket("Needs decision", q.needsDecision)}
      {bucket("Ready to accept", q.readyToAccept)}
      {bucket("In progress", q.inProgress)}
      {bucket("Blocked / open exceptions", q.blocked)}
      {bucket("Ready to invoice", q.readyToInvoice)}
      <Section title={`Waiting on customer (${q.waitingOnCustomer.length})`}>
        <ul class="plain">
          {q.waitingOnCustomer.map((j) => (
            <li>
              <a href={`/op/jobs/${j.id}`}>{j.ref}</a> <Status status={j.status} /> <small>since {formatTime(j.updated_at, tz)}</small>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Unpaid issued invoices (${q.unpaidInvoices.length})`}>
        <ul class="plain">
          {q.unpaidInvoices.map((i) => (
            <li>
              <a href={`/op/invoices/${i.id}`}>
                {i.number} rev {i.revision}
              </a>{" "}
              — {i.ref} — {formatMoney(i.total_cents)} <small>issued {formatTime(i.issued_at, tz)}</small>
            </li>
          ))}
        </ul>
      </Section>
      {q.failedAgentRuns.length > 0 && (
        <Section title="Catherine runs that failed (last 7 days)">
          <ul class="plain">
            {q.failedAgentRuns.map((r) => (
              <li>
                <a href={`/op/jobs/${r.job_id}#catherine`}>{r.ref}</a> — {r.status} <small>{r.last_error}</small>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Layout>,
  );
});

operator.get("/jobs/:id", async (c) => {
  const actor = c.get("actor")!;
  const cfg = config(c.env);
  const tz = cfg.timezone;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const acked = await acknowledgeJobNotifications(c.env, job.id, actor.userId);
  if (acked > 0) {
    await eventInsert(c.env.DB, { jobId: job.id, actor: { userId: actor.userId, role: "operator" }, type: "notification.acknowledged", jobVersion: job.version, detail: { count: acked } }).run();
  }
  const [quotes, messages, files, events, invoices, expenses, wo, runs, ai, draft, completion, notifications, customer] = await Promise.all([
    listQuotes(c.env.DB, job.id),
    listMessages(c.env.DB, job.id, false),
    listAttachments(c.env.DB, job.id),
    listEvents(c.env.DB, job.id, false),
    listInvoices(c.env.DB, job.id, false),
    listExpenses(c.env.DB, job.id),
    currentWorkOrder(c.env.DB, job),
    listRuns(c.env.DB, job.id),
    agentStatus(c.env),
    latestQuoteDraft(c.env.DB, job.id),
    c.env.DB.prepare("SELECT * FROM completions WHERE job_id = ?").bind(job.id).first<CompletionRow>(),
    c.env.DB.prepare("SELECT id, template, recipient_email, status, attempts, last_error, acknowledged_at, created_at FROM notifications WHERE job_id = ? ORDER BY created_at")
      .bind(job.id)
      .all<{ id: string; template: string; recipient_email: string; status: string; attempts: number; last_error: string | null; acknowledged_at: number | null; created_at: number }>(),
    c.env.DB.prepare('SELECT email, name FROM "user" WHERE id = ?').bind(job.customer_id).first<{ email: string; name: string }>(),
  ]);
  const quote = quotes.find((q) => q.id === job.current_quote_id) ?? null;
  const available = quote ? await windowIsAvailable(c.env.DB, quote.window_start, quote.window_end) : undefined;
  const spent = quote ? expenses.filter((e) => e.quote_id === quote.id).reduce((s, e) => s + e.amount_cents, 0) : 0;
  const fieldState = ["dispatched", "in_progress", "blocked"].includes(job.status);
  const quotable = ["requested", "needs_info", "quoted", "approved", "dispatched", "in_progress", "blocked"].includes(job.status);
  const currentRun = runs.runs[0];
  return c.html(
    <Layout title={job.ref} actor={actor} flash={c.req.query("ok")}>
      <h1>
        {job.ref} <Status status={job.status} />
      </h1>
      <section class="card">
        <div class="row">
          <Yes ok={quote?.status === "approved"} yes={`Customer approved v${quote?.version}`} no="No customer approval of the current quote" />
          <Yes ok={Boolean(quote?.operator_accepted_at)} yes="You accepted" no="Not accepted by you" />
          {quote && <Yes ok={available === true} yes="Within availability" no="Outside declared availability" />}
        </div>
        <p>
          <strong>Next:</strong> {nextAction(job, { accepted: Boolean(quote?.operator_accepted_at), available })}
        </p>
        {job.blocked_reason && <p class="flash err">Blocked: {job.blocked_reason}</p>}
        <small>
          Record version {job.version} · updated {formatTime(job.updated_at, tz)} · customer {customer?.email} · source {job.source}
        </small>
      </section>

      {job.status === "approved" && quote && (
        <ActionForm action={`/op/jobs/${job.id}/accept`} version={job.version}>
          <input type="hidden" name="quote_id" value={quote.id} />
          <button type="submit">Accept and dispatch (quote v{quote.version})</button>
        </ActionForm>
      )}
      {job.status === "quoted" && quote && !quote.operator_accepted_at && (
        <ActionForm action={`/op/jobs/${job.id}/accept`} version={job.version}>
          <input type="hidden" name="quote_id" value={quote.id} />
          <button type="submit" class="secondary">
            Pre-accept quote v{quote.version} (dispatches when the customer approves)
          </button>
        </ActionForm>
      )}

      <Section title="Request">
        <dl class="kv">
          <dt>Outcome</dt>
          <dd>{job.requested_outcome}</dd>
          <dt>Instructions</dt>
          <dd>{job.instructions || "—"}</dd>
          <dt>Contact</dt>
          <dd>{job.contact_method}</dd>
          <dt>Pickup</dt>
          <dd>{job.pickup_location || "—"}</dd>
          <dt>Destination</dt>
          <dd>{job.destination || "—"}</dd>
          <dt>Recipient</dt>
          <dd>{job.destination_contact || "—"}</dd>
          <dt>Timing</dt>
          <dd>{job.requested_timing || "—"}</dd>
          <dt>Limits</dt>
          <dd>{job.limits || "—"}</dd>
        </dl>
        <h3>Files</h3>
        <ul class="plain">
          {files.map((f) => (
            <li>
              <a href={`/files/${f.id}`}>{f.filename}</a> <small>{f.kind.replace("_", " ")} · {Math.ceil(f.size / 1024)} KB · sha256 {f.sha256.slice(0, 12)}</small>
            </li>
          ))}
        </ul>
      </Section>

      {wo && (
        <Section title="Work order" note={<a href={`/op/work-orders/${wo.id}`}>Open printable work order</a>}>
          <p>
            Created {formatTime(wo.created_at, tz)} for quote v{quote?.version}.
          </p>
        </Section>
      )}

      {fieldState && (
        <Section title="Field updates" id="field">
          {job.status === "dispatched" && (
            <ActionForm action={`/op/jobs/${job.id}/start`} version={job.version}>
              <button type="submit">Start job</button>
            </ActionForm>
          )}
          {job.status === "blocked" ? (
            <ActionForm action={`/op/jobs/${job.id}/resolve`} version={job.version}>
              <Field label="How was the issue resolved?" name="resolution" rows={2} required />
              <button type="submit">Resolve issue</button>
            </ActionForm>
          ) : (
            <ActionForm action={`/op/jobs/${job.id}/issue`} version={job.version}>
              <Field label="Report issue (closed office, recipient unavailable, wrong document…)" name="issue" rows={2} required />
              <button type="submit" class="secondary">
                Report issue
              </button>
            </ActionForm>
          )}
          <h3>Evidence</h3>
          <ActionForm action={`/op/jobs/${job.id}/evidence`} version={job.version} multipart>
            <Field label="Photo or file" name="files" type="file" multiple accept="image/*,.pdf" />
            <Field label="Note" name="note" />
            <button type="submit" class="secondary">
              Upload evidence
            </button>
          </ActionForm>
          {quote && (
            <>
              <h3>
                Outside expenses — {formatMoney(spent)} of {formatMoney(quote.expense_ceiling_cents)} used
              </h3>
              <ActionForm action={`/op/jobs/${job.id}/expense`} version={job.version} multipart>
                <MoneyField label="Amount" name="amount" required />
                <Field label="What was it for?" name="description" required />
                <Field label="Receipt" name="receipt" type="file" required accept="image/*,.pdf" />
                <button type="submit" class="secondary">
                  Record expense
                </button>
              </ActionForm>
            </>
          )}
          {(job.status === "in_progress" || job.status === "blocked") && (
            <div id="complete">
              <h3>Complete</h3>
              <ActionForm action={`/op/jobs/${job.id}/complete`} version={job.version}>
                <input type="hidden" name="event_key" value={crypto.randomUUID()} />
                <Field label="What happened" name="summary" rows={3} required />
                <label class="field">
                  <span>Outcome</span>
                  <select name="outcome">
                    <option value="completed">Completed as authorized</option>
                    <option value="completed_with_exception">Completed with an unresolved exception</option>
                  </select>
                </label>
                <Field label="Unresolved items (required for an exception)" name="unresolved_items" rows={2} />
                <button type="submit">Confirm completion</button>
              </ActionForm>
            </div>
          )}
        </Section>
      )}

      {expenses.length > 0 && (
        <Section title="Expenses">
          <ul class="plain">
            {expenses.map((e) => (
              <li>
                {formatMoney(e.amount_cents)} — {e.description} · <a href={`/files/${e.receipt_attachment_id}`}>receipt</a> <small>{formatTime(e.created_at, tz)}</small>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {completion && (
        <Section title="Completion">
          <dl class="kv">
            <dt>Outcome</dt>
            <dd>{completion.outcome.replace(/_/g, " ")}</dd>
            <dt>Summary</dt>
            <dd>{completion.summary}</dd>
            <dt>Unresolved</dt>
            <dd>{completion.unresolved_items || "—"}</dd>
            <dt>Confirmed</dt>
            <dd>{formatTime(completion.created_at, tz)}</dd>
          </dl>
          {completion.outcome === "completed_with_exception" && !completion.exception_resolved_at && (
            <ActionForm action={`/op/jobs/${job.id}/resolve-exception`}>
              <Field label="Exception resolution" name="note" required />
              <button type="submit" class="secondary">
                Mark exception resolved
              </button>
            </ActionForm>
          )}
        </Section>
      )}

      {invoices.length > 0 && (
        <Section title="Invoices">
          <ul class="plain">
            {invoices.map((i) => (
              <li>
                <a href={`/op/invoices/${i.id}`}>
                  {i.number} rev {i.revision}
                </a>{" "}
                — <strong>{i.status.toUpperCase()}</strong> — {formatMoney(i.total_cents)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Quote" id="quote">
        {quote ? <QuoteSummary q={quote} tz={tz} /> : <p class="muted">No quote yet.</p>}
        {quotes.length > 1 && (
          <details>
            <summary>Earlier versions ({quotes.length - 1})</summary>
            {quotes
              .filter((q) => q.id !== quote?.id)
              .map((q) => (
                <QuoteSummary q={q} tz={tz} />
              ))}
          </details>
        )}
        {quotable && (
          <details open={!quote || Boolean(c.req.query("prefill"))}>
            <summary>{quote ? "Send a revised quote (voids current approval and acceptance)" : "Send a quote"}</summary>
            {draft && <p class="provisional">Prefilled from a Catherine (PROVISIONAL) draft you approved. Check every field; fees are never filled in by Catherine.</p>}
            <QuoteForm job={job} prev={quote} draft={draft} tz={tz} />
          </details>
        )}
      </Section>

      <Section title="Messages">
        {messages.map((m) => (
          <div class={`msg ${m.visibility}`}>
            <small>
              {m.author_role} · {m.visibility === "internal" ? "internal" : "customer-visible"} · {m.kind} · {formatTime(m.created_at, tz)}
            </small>
            {m.body}
          </div>
        ))}
        {!["cancelled", "declined", "paid"].includes(job.status) && (
          <>
            <ActionForm action={`/op/jobs/${job.id}/message`} version={job.version}>
              <Field label="Message to customer" name="body" rows={2} required />
              <input type="hidden" name="visibility" value="customer" />
              <button type="submit">Send to customer</button>
            </ActionForm>
            <ActionForm action={`/op/jobs/${job.id}/message`} version={job.version}>
              <Field label="Internal note" name="body" rows={2} required />
              <input type="hidden" name="visibility" value="internal" />
              <button type="submit" class="secondary">
                Add internal note
              </button>
            </ActionForm>
          </>
        )}
        {["requested", "needs_info"].includes(job.status) && (
          <ActionForm action={`/op/jobs/${job.id}/request-info`} version={job.version}>
            <Field label="Questions for the customer (moves job to 'waiting for information')" name="questions" rows={2} required />
            <button type="submit" class="secondary">
              Ask for information
            </button>
          </ActionForm>
        )}
        {["requested", "needs_info", "quoted", "approved"].includes(job.status) && (
          <ActionForm action={`/op/jobs/${job.id}/decline`} version={job.version}>
            <Field label="Reason for declining (sent to customer)" name="reason" required />
            <button type="submit" class="danger">
              Decline job
            </button>
          </ActionForm>
        )}
      </Section>

      <CatherinePanel job={job} runs={runs.runs} actions={runs.actions} aiReason={ai.available ? null : ai.reason} specLabel={`${ai.spec.id} v${ai.spec.version} (${ai.spec.status})`} currentRun={currentRun} tz={tz} />

      <Section title="Notifications for this job">
        <ul class="plain">
          {notifications.results.map((n) => (
            <li>
              {n.template} → {n.recipient_email}: <strong>{n.status}</strong> (attempts {n.attempts}){n.acknowledged_at ? " · acknowledged" : ""}
              {n.last_error && <small>{n.last_error}</small>}
            </li>
          ))}
        </ul>
        <p class="muted">"simulated" means the local dev mailbox recorded it; it was not sent by a real provider.</p>
      </Section>

      <Section title="Audit history">
        <table>
          <tbody>
            {events.map((e) => (
              <tr>
                <td>
                  <small>{formatTime(e.created_at, tz)}</small>
                  {e.type}
                  {e.from_status && e.to_status && e.from_status !== e.to_status ? ` (${e.from_status} → ${e.to_status})` : ""}
                  <small>
                    by {e.actor_role}
                    {e.actor_id ? ` ${e.actor_id.slice(0, 12)}` : ""} · v{e.job_version}
                    {e.ref_table ? ` · ${e.ref_table}/${e.ref_id}` : ""} · {e.visibility}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </Layout>,
  );
});

const QuoteSummary = ({ q, tz }: { q: QuoteRow; tz: string }) => (
  <div class="qcard">
    <h3>
      Version {q.version} — {q.status}
    </h3>
    <dl class="kv">
      <dt>Scope</dt>
      <dd>{q.scope}</dd>
      <dt>Steps</dt>
      <dd>{stepsOf(q).join("\n")}</dd>
      <dt>Fee / ceiling</dt>
      <dd>
        {formatMoney(q.service_fee_cents)} / {formatMoney(q.expense_ceiling_cents)}
      </dd>
      <dt>Window</dt>
      <dd>{formatWindow(q.window_start, q.window_end, tz)}</dd>
      <dt>Customer decision</dt>
      <dd>{q.customer_decision_at ? `${q.status === "rejected" ? "Rejected" : "Approved"} ${formatTime(q.customer_decision_at, tz)}${q.customer_decision_note ? ` — ${q.customer_decision_note}` : ""}` : "None"}</dd>
      <dt>Operator acceptance</dt>
      <dd>{q.operator_accepted_at ? formatTime(q.operator_accepted_at, tz) : "None"}</dd>
      <dt>Content hash</dt>
      <dd>
        <small>{q.content_hash.slice(0, 16)}</small>
      </dd>
    </dl>
  </div>
);

const QuoteForm = ({ job, prev, draft, tz }: { job: JobRow; prev: QuoteRow | null; draft: Awaited<ReturnType<typeof latestQuoteDraft>>; tz: string }) => {
  const fromDraft = (v: string | null | undefined) => v ?? undefined;
  const money = (cents: number | undefined) => (cents === undefined ? undefined : (cents / 100).toFixed(2));
  const draftStart = draft?.quote_window_start ?? undefined;
  const draftEnd = draft?.quote_window_end ?? undefined;
  return (
    <ActionForm action={`/op/jobs/${job.id}/quote`} version={job.version}>
      <Field label="Scope" name="scope" rows={2} required value={prev?.scope ?? fromDraft(draft?.quote_scope)} />
      <Field label="Authorized steps (one per line)" name="authorized_steps" rows={4} required value={prev ? stepsOf(prev).join("\n") : draft?.quote_authorized_steps?.join("\n")} />
      <MoneyField label="Service fee (USD)" name="service_fee" required value={money(prev?.service_fee_cents)} hint="Rates are not set for real use. Use test values only." />
      <MoneyField label="Outside-expense ceiling (USD)" name="expense_ceiling" required value={money(prev?.expense_ceiling_cents ?? (draft?.quote_expense_ceiling_usd != null ? Math.round(draft.quote_expense_ceiling_usd * 100) : undefined))} />
      <Field label="Window start" name="window_start" type="datetime-local" required value={prev ? utcToLocalInput(prev.window_start, tz) : draftStart} hint={`Time zone: ${tz}`} />
      <Field label="Window end" name="window_end" type="datetime-local" required value={prev ? utcToLocalInput(prev.window_end, tz) : draftEnd} />
      <Field label="Cancellation and exception terms" name="terms" rows={2} required value={prev?.terms ?? fromDraft(draft?.quote_terms)} />
      <Field label="Customer authority required" name="required_authority" value={prev?.required_authority} />
      <Field label="Required materials" name="required_materials" value={prev?.required_materials ?? fromDraft(draft?.quote_required_materials)} />
      <Field label="Completion evidence" name="completion_evidence" value={prev?.completion_evidence ?? fromDraft(draft?.quote_completion_evidence)} />
      <Field label="What to do when blocked" name="if_blocked" value={prev?.if_blocked ?? fromDraft(draft?.quote_if_blocked)} />
      <button type="submit">Send quote to customer</button>
    </ActionForm>
  );
};

const CatherinePanel = ({ job, runs, actions, aiReason, specLabel, currentRun, tz }: { job: JobRow; runs: RunView[]; actions: ActionView[]; aiReason: string | null; specLabel: string; currentRun: RunView | undefined; tz: string }) => {
  let plan: Record<string, unknown> | null = null;
  try {
    plan = currentRun?.output ? JSON.parse(currentRun.output) : null;
  } catch {
    plan = null;
  }
  const list = (k: string) => (Array.isArray(plan?.[k]) ? (plan![k] as unknown[]) : []);
  return (
    <Section title="Catherine — PROVISIONAL role" id="catherine" note={`Spec ${specLabel}. Proposals only: nothing executes until you approve it.`}>
      {aiReason && <p class="flash err">{aiReason}</p>}
      {!aiReason && (
        <ActionForm action={`/op/jobs/${job.id}/plan`}>
          <button type="submit" class="secondary">
            Ask Catherine for a plan
          </button>
        </ActionForm>
      )}
      {currentRun && (
        <div class="provisional">
          <p>
            <strong>Latest run:</strong> {currentRun.status} · {currentRun.provider}/{currentRun.model} · attempts {currentRun.attempts}/{currentRun.max_attempts} · spec {currentRun.spec_id} v{currentRun.spec_version} ({currentRun.spec_sha256.slice(0, 10)}) ·{" "}
            {currentRun.cost_microusd !== null ? `$${(currentRun.cost_microusd / 1e6).toFixed(5)}` : "cost n/a"} · {formatTime(currentRun.created_at, tz)}
          </p>
          {currentRun.job_version !== job.version && <p class="flash err">Stale: this plan was made from record version {currentRun.job_version}; the job is now version {job.version}.</p>}
          {currentRun.last_error && <p class="flash err">Error: {currentRun.last_error}</p>}
          {plan && (
            <>
              <p>{String(plan.summary ?? "")}</p>
              <p>
                <strong>Service fit:</strong> {String(plan.service_fit ?? "")}
              </p>
              {(["missing_information", "unsupported_or_excluded", "digital_steps", "physical_steps", "risks"] as const).map((k) =>
                list(k).length ? (
                  <>
                    <h3>{k.replace(/_/g, " ")}</h3>
                    <ul>
                      {list(k).map((x) => (
                        <li>{String(x)}</li>
                      ))}
                    </ul>
                  </>
                ) : null,
              )}
              {list("assumptions").length > 0 && (
                <>
                  <h3>assumptions</h3>
                  <ul>
                    {list("assumptions").map((a) => {
                      const v = a as { assumption?: string; evidence?: string; matters_because?: string };
                      return (
                        <li>
                          {v.assumption} — <em>evidence:</em> {v.evidence} — <em>matters because:</em> {v.matters_because}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
          <h3>Proposed actions</h3>
          {actions
            .filter((a) => a.run_id === currentRun.id)
            .map((a) => {
              const args = (() => {
                try {
                  return JSON.parse(a.args) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })();
              const proposedText =
                a.tool === "request_clarification" ? (Array.isArray(args.questions) ? (args.questions as string[]).map((q) => `• ${q}`).join("\n") : "") : typeof args.message_body === "string" ? args.message_body : "";
              return (
                <div class="qcard">
                  <strong>{a.tool}</strong> — {a.status}
                  <small>{a.rationale}</small>
                  {a.validation_error && <p class="flash err">Rejected by validation: {a.validation_error}</p>}
                  {a.tool === "draft_quote" && <pre class="msg">{JSON.stringify(args, null, 1)}</pre>}
                  {a.status === "proposed" && (
                    <>
                      <ActionForm action={`/op/actions/${a.id}/approve`}>
                        {a.tool !== "draft_quote" && <Field label="Text (edit before approving)" name="body" rows={3} value={proposedText} />}
                        <button type="submit">{a.tool === "draft_quote" ? "Use as quote form starting point" : "Approve and execute"}</button>
                      </ActionForm>
                      <ActionForm action={`/op/actions/${a.id}/reject`}>
                        <button type="submit" class="secondary">
                          Reject
                        </button>
                      </ActionForm>
                    </>
                  )}
                  {a.result && <small>Result: {a.result}</small>}
                </div>
              );
            })}
        </div>
      )}
      {runs.length > 1 && <small>{runs.length - 1} earlier run(s) recorded.</small>}
    </Section>
  );
};

const go = (jobId: string, ok: string, hash = "") => `/op/jobs/${jobId}?ok=${ok}${hash}`;

operator.post("/jobs/:id/:op{resolve-exception|message|request-info|decline|quote|accept|start|issue|resolve|plan}", async (c) => {
  const actor = c.get("actor")!;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const b = await c.req.parseBody();
  const op = c.req.param("op");
  let ok = "saved";
  switch (op) {
    case "message":
      await postMessage(c.env, actor, job, b.body, { visibility: b.visibility === "customer" ? "customer" : "internal", postedVersion: b.version, kind: b.visibility === "customer" ? "message" : "note" });
      ok = "message_sent";
      break;
    case "request-info":
      await requestInfo(c.env, actor, job, b.questions, b.version);
      ok = "info_requested";
      break;
    case "decline":
      await declineJob(c.env, actor, job, b.reason, b.version);
      ok = "declined";
      break;
    case "quote":
      await sendQuote(c.env, actor, job, b as never, b.version);
      ok = "quote_sent";
      break;
    case "accept":
      ok = (await acceptAssignment(c.env, actor, job, b.quote_id, b.version)) === "dispatched" ? "dispatched" : "accepted";
      break;
    case "start":
      await startWork(c.env, actor, job, b.version);
      ok = "started";
      break;
    case "issue":
      await reportIssue(c.env, actor, job, b.issue, b.version);
      ok = "blocked";
      break;
    case "resolve":
      await resolveIssue(c.env, actor, job, b.resolution, b.version);
      ok = "unblocked";
      break;
    case "plan":
      await requestPlan(c.env, actor, job);
      ok = "plan_requested";
      break;
    case "resolve-exception":
      await resolveException(c.env, actor, job, b.note);
      ok = "exception_resolved";
      break;
  }
  kick(c.env, c.executionCtx);
  return c.redirect(go(job.id, ok, op === "plan" ? "#catherine" : ""), 303);
});

operator.post("/jobs/:id/:op{evidence|expense}", async (c) => {
  const actor = c.get("actor")!;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const b = await c.req.parseBody({ all: true });
  if (c.req.param("op") === "evidence") {
    await uploadEvidence(c.env, actor, job, pickFiles(b.files), b.note, b.version);
    return c.redirect(go(job.id, "evidence", "#field"), 303);
  }
  await reportExpense(c.env, actor, job, b.amount, b.description, pickFiles(b.receipt), b.version);
  return c.redirect(go(job.id, "expense", "#field"), 303);
});

operator.post("/jobs/:id/complete", async (c) => {
  const actor = c.get("actor")!;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const b = await c.req.parseBody();
  const r = await completeJob(c.env, actor, job, { summary: b.summary, unresolved_items: b.unresolved_items, outcome: b.outcome, event_key: b.event_key }, b.version);
  kick(c.env, c.executionCtx);
  return c.redirect(go(job.id, r.duplicate ? "completed_duplicate" : "completed"), 303);
});

operator.post("/actions/:id/:decision{approve|reject}", async (c) => {
  const actor = c.get("actor")!;
  const row = await c.env.DB.prepare("SELECT job_id FROM agent_actions WHERE id = ?").bind(c.req.param("id")).first<{ job_id: string }>();
  if (!row) throw notFound("Action not found");
  if (c.req.param("decision") === "reject") {
    await rejectAction(c.env, actor, c.req.param("id"));
    return c.redirect(go(row.job_id, "action_rejected", "#catherine"), 303);
  }
  const b = await c.req.parseBody();
  const r = await approveAction(c.env, actor, c.req.param("id"), { body: b.body });
  kick(c.env, c.executionCtx);
  return c.redirect(r.redirectToQuote ? `/op/jobs/${row.job_id}?ok=action_done&prefill=1#quote` : go(row.job_id, "action_done", "#catherine"), 303);
});

operator.get("/work-orders/:id", async (c) => {
  const actor = c.get("actor")!;
  const wo = await c.env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(c.req.param("id")).first<{ id: string; job_id: string; content: string }>();
  if (!wo) throw notFound("Work order not found");
  return c.html(
    <Layout title="Work order" actor={actor}>
      <WorkOrderView wo={JSON.parse(wo.content) as WorkOrderContent} tz={config(c.env).timezone} />
      <a href={`/op/jobs/${wo.job_id}`}>Back to job</a>
    </Layout>,
  );
});

operator.get("/invoices/:id", async (c) => {
  const actor = c.get("actor")!;
  const data = await getInvoiceFor(c.env, actor, c.req.param("id"));
  const inv = data.invoice;
  return c.html(
    <Layout title={inv.number} actor={actor} flash={c.req.query("ok")}>
      <InvoiceView {...data} tz={config(c.env).timezone} />
      {inv.status === "draft" && data.job.status === "completed" && (
        <ActionForm action={`/op/invoices/${inv.id}/issue`}>
          <button type="submit">Issue invoice {inv.number} rev {inv.revision}</button>
        </ActionForm>
      )}
      {inv.status === "issued" && (
        <Section title="Record payment confirmation" note="Record only verified payment. No payment provider is connected; this is a manual confirmation with a reference.">
          <ActionForm action={`/op/invoices/${inv.id}/payment`}>
            <input type="hidden" name="idempotency_key" value={crypto.randomUUID()} />
            <MoneyField label="Amount received" name="amount" required value={((inv.total_cents - data.payments.reduce((s, p) => s + p.amount_cents, 0)) / 100).toFixed(2)} />
            <Field label="Evidence / reference" name="reference" required hint="For example: test payment reference, bank transfer id." />
            <button type="submit">Record payment</button>
          </ActionForm>
          {data.payments.length === 0 && (
            <ActionForm action={`/op/invoices/${inv.id}/revise`}>
              <Field label="Correction reason (voids this revision and creates a new draft revision)" name="reason" required />
              <button type="submit" class="secondary">
                Void and redraft
              </button>
            </ActionForm>
          )}
        </Section>
      )}
      <a href={`/op/jobs/${data.job.id}`}>Back to {data.job.ref}</a>
    </Layout>,
  );
});

operator.post("/invoices/:id/:op{issue|payment|revise}", async (c) => {
  const actor = c.get("actor")!;
  const id = c.req.param("id");
  const b = await c.req.parseBody();
  let target = id;
  let ok = "saved";
  switch (c.req.param("op")) {
    case "issue":
      await issueInvoice(c.env, actor, id);
      ok = "issued";
      break;
    case "payment": {
      const r = await recordPayment(c.env, actor, id, { amount: b.amount, reference: b.reference, idempotency_key: b.idempotency_key });
      ok = r.duplicate ? "payment_duplicate" : "paid";
      break;
    }
    case "revise":
      target = await voidAndRedraft(c.env, actor, id, b.reason);
      ok = "revised";
      break;
  }
  kick(c.env, c.executionCtx);
  return c.redirect(`/op/invoices/${target}?ok=${ok}`, 303);
});

operator.post("/notifications/:id/retry", async (c) => {
  await retryNotification(c.env, c.req.param("id"), c.get("actor")!.userId);
  kick(c.env, c.executionCtx);
  return c.redirect("/op?ok=retry", 303);
});

operator.get("/availability", async (c) => {
  const actor = c.get("actor")!;
  const tz = config(c.env).timezone;
  const rows = await listAvailability(c.env.DB);
  return c.html(
    <Layout title="Availability" actor={actor} flash={c.req.query("ok")}>
      <h1>Your availability</h1>
      <p class="muted">You can accept a job only when its whole quoted window falls inside one of these blocks. Jobs outside them stay pending.</p>
      <ul class="plain card">
        {rows.length === 0 && <li class="muted">No availability declared.</li>}
        {rows.map((r) => (
          <li class="row" style="justify-content:space-between">
            <span>
              {formatWindow(r.starts_at, r.ends_at, tz)} {r.note && <small>{r.note}</small>}
            </span>
            <ActionForm action={`/op/availability/${r.id}/remove`} class="inline">
              <button type="submit" class="secondary">
                Remove
              </button>
            </ActionForm>
          </li>
        ))}
      </ul>
      <Section title="Add availability">
        <ActionForm action="/op/availability">
          <Field label="From" name="start" type="datetime-local" required hint={`Time zone: ${tz}`} />
          <Field label="To" name="end" type="datetime-local" required />
          <Field label="Note" name="note" />
          <button type="submit">Add</button>
        </ActionForm>
      </Section>
    </Layout>,
  );
});

operator.post("/availability", async (c) => {
  const b = await c.req.parseBody();
  await addAvailability(c.env, c.get("actor")!, b.start, b.end, b.note);
  return c.redirect("/op/availability?ok=availability_added", 303);
});

operator.post("/availability/:id/remove", async (c) => {
  await removeAvailability(c.env, c.get("actor")!, c.req.param("id"));
  return c.redirect("/op/availability?ok=availability_removed", 303);
});

operator.get("/partners", async (c) => {
  const actor = c.get("actor")!;
  const tz = config(c.env).timezone;
  const { partners, ledger } = await partnersWithLedger(c.env);
  const cfg = config(c.env);
  return c.html(
    <Layout title="Partners" actor={actor} flash={c.req.query("ok")}>
      <h1>Referral partners</h1>
      <p class="banner">No partner agreement exists. Rates here are TEST values for reconciliation testing, not commercial terms.</p>
      {partners.map((p) => {
        const rows = ledger.filter((l) => l.partner_id === p.id);
        const sum = (status: string) => rows.filter((l) => l.status === status).reduce((s, l) => s + l.amount_cents, 0);
        return (
          <Section title={p.name}>
            <dl class="kv">
              <dt>Referral link</dt>
              <dd>
                {cfg.appUrl}/r/{p.ref_code}
              </dd>
              <dt>Partner sign-in</dt>
              <dd>{p.login_email ?? "none"}</dd>
              <dt>Test share</dt>
              <dd>
                {(p.share_rate_bps / 100).toFixed(2)}% of service fee · terms {p.terms_status} · {p.policy_label}
              </dd>
              <dt>Pending collection</dt>
              <dd>{formatMoney(sum("pending_collection"))}</dd>
              <dt>Earned (collected)</dt>
              <dd>{formatMoney(sum("earned"))}</dd>
            </dl>
            <table>
              <thead>
                <tr>
                  <th>Job / invoice</th>
                  <th class="num">Basis</th>
                  <th class="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr>
                    <td>
                      {l.ref} · {l.number} rev {l.revision} · {l.entry_type} · {l.status}
                      <small>{formatTime(l.created_at, tz)}</small>
                    </td>
                    <td class="num">{formatMoney(l.basis_cents)}</td>
                    <td class="num">{formatMoney(l.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        );
      })}
      <Section title="Add partner">
        <ActionForm action="/op/partners">
          <Field label="Name" name="name" required />
          <Field label="Partner sign-in email (optional)" name="login_email" type="email" />
          <Field label="TEST share of service fee (%)" name="share_percent" value="20" hint="Illustrative only. Excludes reimbursements." />
          <button type="submit">Add partner</button>
        </ActionForm>
      </Section>
    </Layout>,
  );
});

operator.post("/partners", async (c) => {
  const b = await c.req.parseBody();
  await createPartner(c.env, c.get("actor")!, { name: b.name, login_email: b.login_email, share_percent: b.share_percent });
  return c.redirect("/op/partners?ok=partner_created", 303);
});

operator.get("/system", async (c) => {
  const actor = c.get("actor")!;
  const cfg = config(c.env);
  const ai = await agentStatus(c.env);
  const pending = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM notifications GROUP BY status").all<{ status: string; n: number }>();
  return c.html(
    <Layout title="System" actor={actor}>
      <h1>System status</h1>
      <Section title="Configuration (no secrets shown)">
        <dl class="kv">
          <dt>Environment</dt>
          <dd>{cfg.env}</dd>
          <dt>Live mode</dt>
          <dd>{cfg.liveMode ? "ON" : "OFF — test customers, test invoices only"}</dd>
          <dt>Email provider</dt>
          <dd>{cfg.emailProvider}{cfg.emailProvider === "dev" ? " (local mailbox only — nothing is really sent)" : ""}</dd>
          <dt>Operator addresses</dt>
          <dd>{cfg.operatorEmails.length} configured</dd>
          <dt>AI provider / model</dt>
          <dd>
            {ai.provider} / {ai.model || "—"} {ai.available ? "(available)" : `(unavailable: ${ai.reason})`}
          </dd>
          <dt>Catherine spec</dt>
          <dd>
            {ai.spec.id} v{ai.spec.version} — {ai.spec.status.toUpperCase()} — sha256 {ai.spec.sha256.slice(0, 16)}
          </dd>
          <dt>AI spend this month</dt>
          <dd>
            ${ai.monthToDateUsd.toFixed(4)} of ${ai.budgetUsd.toFixed(2)} budget (application-enforced)
          </dd>
          <dt>Tax</dt>
          <dd>Not configured. Real invoices cannot be issued.</dd>
          <dt>Notifications by status</dt>
          <dd>{pending.results.map((r) => `${r.status}: ${r.n}`).join(" · ") || "none"}</dd>
        </dl>
      </Section>
      <Section title="Backup">
        <p>
          <a href="/op/export">Download a JSON export</a> of business records (excludes session tokens and sign-in codes). Full database backups use <code>wrangler d1 export</code>; see docs/OPERATIONS.md.
        </p>
      </Section>
    </Layout>,
  );
});

const EXPORT_TABLES = [
  "partners",
  "jobs",
  "job_events",
  "job_messages",
  "attachments",
  "availability",
  "quotes",
  "work_orders",
  "expenses",
  "completions",
  "invoices",
  "invoice_lines",
  "payments",
  "partner_ledger",
  "notifications",
  "agent_runs",
  "agent_actions",
  "counters",
  "settings",
];

operator.get("/export", async (c) => {
  const out: Record<string, unknown[]> = {};
  for (const t of EXPORT_TABLES) out[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  out.users = (await c.env.DB.prepare('SELECT id, name, email, role, "partnerId", "createdAt" FROM "user"').all()).results;
  const body = JSON.stringify({ exported_at: new Date().toISOString(), note: "Business records only. R2 file objects are referenced by r2_key and backed up separately.", tables: out }, null, 1);
  return c.body(body, 200, {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="operator-export-${new Date().toISOString().slice(0, 10)}.json"`,
  });
});
