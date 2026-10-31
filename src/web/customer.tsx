import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Actor } from "../auth";
import { kick } from "../background";
import { getInvoiceFor, listInvoices } from "../domain/billing";
import { decideQuote, getQuote, stepsOf } from "../domain/dispatch";
import { listEvents } from "../domain/events";
import { listAttachments, pickFiles, stageFiles } from "../domain/files";
import { cancelJob, createJob, getJobFor, listCustomerJobs, listMessages, postMessage, requireRole, touchJob } from "../domain/jobs";
import { eventInsert } from "../domain/events";
import { config, type Env } from "../env";
import { runBatch } from "../lib/db";
import { invalid } from "../lib/errors";
import { formatMoney, formatTime, formatWindow } from "../lib/format";
import { ActionForm, Field, Layout, Section, Status } from "./ui";
import { InvoiceView } from "./shared";

type C = { Bindings: Env; Variables: { actor: Actor | null } };
export const customer = new Hono<C>();

customer.use("*", async (c, next) => {
  requireRole(c.get("actor"), "customer");
  await next();
});

customer.get("/", async (c) => {
  const actor = c.get("actor")!;
  const tz = config(c.env).timezone;
  const jobs = await listCustomerJobs(c.env, actor);
  return c.html(
    <Layout title="My requests" actor={actor} flash={c.req.query("ok")}>
      <div class="row" style="justify-content:space-between">
        <h1>My requests</h1>
        <a class="btn" href="/c/new">
          New request
        </a>
      </div>
      {jobs.length === 0 && <p class="muted">No requests yet.</p>}
      <ul class="plain card">
        {jobs.map((j) => (
          <li>
            <a href={`/c/jobs/${j.id}`}>
              <strong>{j.ref}</strong>
            </a>{" "}
            <Status status={j.status} />
            <div>{j.requested_outcome}</div>
            <small>Submitted {formatTime(j.created_at, tz)}</small>
          </li>
        ))}
      </ul>
    </Layout>,
  );
});

customer.get("/new", (c) =>
  c.html(
    <Layout title="New request" actor={c.get("actor")}>
      <h1>New request</h1>
      <p class="muted">
        Supported: delivering or collecting documents you supply; printing, scanning and collating to your instructions; typing your words and organizing files; defined local errands. Not offered: legal advice, legal-document
        drafting, notarization, or signing for you. Submitting is not a booking — you will receive a quote to approve first.
      </p>
      <ActionForm action="/c/jobs" multipart>
        <Field label="What result do you need?" name="requested_outcome" rows={3} required />
        <Field label="Instructions" name="instructions" rows={4} hint="Anything the operator must follow exactly." />
        <Field label="How should we contact you?" name="contact_method" required hint="Email, phone, or both." />
        <Field label="Pickup location" name="pickup_location" />
        <Field label="Destination" name="destination" />
        <Field label="Who receives it at the destination?" name="destination_contact" />
        <Field label="When do you need it?" name="requested_timing" hint="For example: Tuesday before noon." />
        <Field label="Limits" name="limits" rows={2} hint="Spending limits, things not to do, deadlines." />
        <Field label="Attach documents" name="files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.txt,.doc,.docx" hint="Up to 5 files. Stored privately." />
        <button type="submit">Submit request</button>
      </ActionForm>
    </Layout>,
  ),
);

customer.post("/jobs", async (c) => {
  const actor = c.get("actor")!;
  const body = await c.req.parseBody({ all: true });
  const job = await createJob(
    c.env,
    actor,
    {
      requested_outcome: body.requested_outcome,
      instructions: body.instructions,
      contact_method: body.contact_method,
      pickup_location: body.pickup_location,
      destination: body.destination,
      destination_contact: body.destination_contact,
      requested_timing: body.requested_timing,
      limits: body.limits,
    },
    pickFiles(body.files),
    getCookie(c, "op_ref") ?? null,
  );
  kick(c.env, c.executionCtx);
  return c.redirect(`/c/jobs/${job.id}?ok=submitted`, 303);
});

customer.get("/jobs/:id", async (c) => {
  const actor = c.get("actor")!;
  const tz = config(c.env).timezone;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const [quote, messages, files, events, invoices] = await Promise.all([
    job.current_quote_id ? getQuote(c.env.DB, job.current_quote_id) : null,
    listMessages(c.env.DB, job.id, true),
    listAttachments(c.env.DB, job.id),
    listEvents(c.env.DB, job.id, true),
    listInvoices(c.env.DB, job.id, true),
  ]);
  const open = !["cancelled", "declined", "paid"].includes(job.status);
  return c.html(
    <Layout title={job.ref} actor={actor} flash={c.req.query("ok")}>
      <h1>
        {job.ref} <Status status={job.status} />
      </h1>
      {quote && quote.status === "sent" && (
        <Section title={`Quote version ${quote.version} — your decision`} id="quote">
          <QuoteDetails quote={quote} tz={tz} />
          <p class="muted">Approving authorizes only the steps, fee and expense ceiling above for this window. Anything beyond it needs your approval again.</p>
          <ActionForm action={`/c/quotes/${quote.id}/approve`}>
            <input type="hidden" name="content_hash" value={quote.content_hash} />
            <Field label="Note (optional)" name="note" />
            <div class="row">
              <button type="submit">Approve this quote</button>
            </div>
          </ActionForm>
          <ActionForm action={`/c/quotes/${quote.id}/reject`}>
            <input type="hidden" name="content_hash" value={quote.content_hash} />
            <input type="hidden" name="note" value="" />
            <button type="submit" class="secondary">
              Reject
            </button>
          </ActionForm>
        </Section>
      )}
      {quote && quote.status === "approved" && (
        <Section title={`Approved quote (version ${quote.version})`}>
          <QuoteDetails quote={quote} tz={tz} />
          <p>{quote.operator_accepted_at ? "The operator accepted this job." : "Waiting for the operator to accept. This is not yet scheduled."}</p>
        </Section>
      )}
      {invoices.length > 0 && (
        <Section title="Invoices">
          <ul class="plain">
            {invoices.map((i) => (
              <li>
                <a href={`/c/invoices/${i.id}`}>
                  {i.is_test ? "TEST " : ""}
                  {i.number} rev {i.revision}
                </a>{" "}
                — {i.status === "void" ? "void (replaced)" : formatMoney(i.total_cents)}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Your request">
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
      </Section>
      <Section title="Files">
        <ul class="plain">
          {files.map((f) => (
            <li>
              <a href={`/files/${f.id}`}>{f.filename}</a> <small>{f.kind.replace("_", " ")} · {Math.ceil(f.size / 1024)} KB</small>
            </li>
          ))}
        </ul>
        {open && (
          <ActionForm action={`/c/jobs/${job.id}/files`} version={job.version} multipart>
            <Field label="Add documents" name="files" type="file" multiple />
            <button type="submit" class="secondary">
              Upload
            </button>
          </ActionForm>
        )}
      </Section>
      <Section title="Messages">
        {messages.map((m) => (
          <div class="msg">
            <small>
              {m.author_role === "customer" ? "You" : "Operator"} · {formatTime(m.created_at, tz)}
            </small>
            {m.body}
          </div>
        ))}
        {open && (
          <ActionForm action={`/c/jobs/${job.id}/message`} version={job.version}>
            <Field label="Message" name="body" rows={3} required />
            <button type="submit">Send</button>
          </ActionForm>
        )}
      </Section>
      <Section title="History">
        <ul class="plain">
          {events.map((e) => (
            <li>
              <small>{formatTime(e.created_at, tz)}</small> {e.type.replace(/[._]/g, " ")}
            </li>
          ))}
        </ul>
      </Section>
      {["requested", "needs_info", "quoted", "approved"].includes(job.status) && (
        <ActionForm action={`/c/jobs/${job.id}/cancel`} version={job.version}>
          <button type="submit" class="danger">
            Cancel this request
          </button>
        </ActionForm>
      )}
    </Layout>,
  );
});

const QuoteDetails = ({ quote, tz }: { quote: NonNullable<Awaited<ReturnType<typeof getQuote>>>; tz: string }) => (
  <dl class="kv">
    <dt>Scope</dt>
    <dd>{quote.scope}</dd>
    <dt>Authorized steps</dt>
    <dd>
      {stepsOf(quote).map((s, i) => (
        <div>
          {i + 1}. {s}
        </div>
      ))}
    </dd>
    <dt>Service fee</dt>
    <dd>{formatMoney(quote.service_fee_cents)}</dd>
    <dt>Outside-expense ceiling</dt>
    <dd>{formatMoney(quote.expense_ceiling_cents)} (reimbursed at cost with receipts, up to this amount)</dd>
    <dt>Time window</dt>
    <dd>{formatWindow(quote.window_start, quote.window_end, tz)}</dd>
    <dt>Terms</dt>
    <dd>{quote.terms}</dd>
    {quote.required_authority && (
      <>
        <dt>Authority you provide</dt>
        <dd>{quote.required_authority}</dd>
      </>
    )}
    <dt>Tax</dt>
    <dd>Not configured — test quote</dd>
  </dl>
);

customer.post("/jobs/:id/message", async (c) => {
  const actor = c.get("actor")!;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const body = await c.req.parseBody();
  await postMessage(c.env, actor, job, body.body, { visibility: "customer", postedVersion: body.version });
  kick(c.env, c.executionCtx);
  return c.redirect(`/c/jobs/${job.id}?ok=message_sent`, 303);
});

customer.post("/jobs/:id/files", async (c) => {
  const actor = c.get("actor")!;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  if (["cancelled", "declined", "paid"].includes(job.status)) throw invalid("This job is closed.");
  const body = await c.req.parseBody({ all: true });
  if (Number(body.version) !== job.version) throw invalid("This job changed. Reload and try again.");
  const files = pickFiles(body.files);
  if (files.length === 0) throw invalid("Choose a file first.");
  const staged = await stageFiles(c.env, job.id, "customer_material", files, actor.userId);
  try {
    await runBatch(c.env.DB, [
      ...touchJob(c.env.DB, job),
      ...staged.statements,
      eventInsert(c.env.DB, { jobId: job.id, actor: { userId: actor.userId, role: "customer" }, type: "files.added", jobVersion: job.version + 1, detail: { files: staged.rows.map((r) => r.id) }, visibility: "customer" }),
    ]);
  } catch (err) {
    await staged.cleanup();
    throw err;
  }
  return c.redirect(`/c/jobs/${job.id}?ok=files_added`, 303);
});

customer.post("/jobs/:id/cancel", async (c) => {
  const actor = c.get("actor")!;
  const job = await getJobFor(c.env, actor, c.req.param("id"));
  const body = await c.req.parseBody();
  await cancelJob(c.env, actor, job, body.version);
  kick(c.env, c.executionCtx);
  return c.redirect(`/c/jobs/${job.id}?ok=cancelled`, 303);
});

customer.post("/quotes/:id/:decision{approve|reject}", async (c) => {
  const actor = c.get("actor")!;
  const body = await c.req.parseBody();
  const decision = c.req.param("decision") as "approve" | "reject";
  await decideQuote(c.env, actor, c.req.param("id"), decision, body.content_hash, body.note);
  kick(c.env, c.executionCtx);
  const q = await getQuote(c.env.DB, c.req.param("id"));
  return c.redirect(`/c/jobs/${q!.job_id}?ok=${decision === "approve" ? "quote_approved" : "quote_rejected"}`, 303);
});

customer.get("/invoices/:id", async (c) => {
  const actor = c.get("actor")!;
  const data = await getInvoiceFor(c.env, actor, c.req.param("id"));
  return c.html(
    <Layout title={data.invoice.number} actor={actor}>
      <InvoiceView {...data} tz={config(c.env).timezone} />
      <p>
        <a href={`/c/jobs/${data.job.id}`}>Back to {data.job.ref}</a>
      </p>
    </Layout>,
  );
});
