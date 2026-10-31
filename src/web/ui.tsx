import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { Actor } from "../auth";
import { STATUS_LABELS } from "../lib/format";

export const FLASH: Record<string, string> = {
  signed_out: "You are signed out.",
  submitted: "Request submitted. It is not a booking until a quote is approved and accepted.",
  saved: "Saved.",
  message_sent: "Message saved.",
  quote_sent: "Quote sent to the customer.",
  quote_approved: "You approved the quote. The job is dispatched only once the operator accepts.",
  quote_rejected: "You rejected the quote. Nothing will be dispatched.",
  accepted: "Accepted. The job dispatches automatically when the customer approves this exact quote version.",
  dispatched: "Dispatched. Work order created.",
  started: "Marked in progress.",
  blocked: "Issue recorded. The job is blocked.",
  unblocked: "Issue resolved.",
  expense: "Expense recorded with receipt.",
  evidence: "Evidence uploaded.",
  completed: "Completion recorded. A numbered DRAFT invoice was created.",
  completed_duplicate: "This completion was already recorded. No second invoice was created.",
  issued: "Invoice issued.",
  revised: "Invoice voided and a new draft revision created.",
  paid: "Payment confirmation recorded.",
  payment_duplicate: "That payment was already recorded.",
  plan_requested: "Catherine (provisional) is preparing a plan. Reload in a moment.",
  action_done: "Action executed.",
  action_rejected: "Action rejected.",
  acknowledged: "Notifications for this job acknowledged.",
  retry: "Notification queued for another attempt.",
  cancelled: "Request cancelled.",
  declined: "Request declined.",
  info_requested: "Questions sent to the customer.",
  partner_created: "Partner added.",
  availability_added: "Availability added.",
  availability_removed: "Availability removed.",
  files_added: "Files added.",
  exception_resolved: "Exception marked resolved.",
};

export const Layout: FC<PropsWithChildren<{ title: string; actor: Actor | null; flash?: string | null; error?: string | null }>> = ({ title, actor, flash, error, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{`${title} · Operator`}</title>
      <link rel="stylesheet" href="/app.css" />
    </head>
    <body>
      <header class="top">
        <a class="brand" href="/">
          Operator
        </a>
        {actor && (
          <nav>
            {actor.role === "operator" && (
              <>
                <a href="/op">Queue</a>
                <a href="/op/availability">Availability</a>
                <a href="/op/partners">Partners</a>
                <a href="/op/system">System</a>
              </>
            )}
            {actor.role === "customer" && (
              <>
                <a href="/c">My requests</a>
                <a href="/c/new">New request</a>
              </>
            )}
            {actor.role === "partner" && <a href="/p">Referrals</a>}
            <form method="post" action="/logout" class="inline">
              <button class="link" type="submit">
                Sign out
              </button>
            </form>
          </nav>
        )}
      </header>
      <main>
        {flash && FLASH[flash] && <p class="flash ok">{FLASH[flash]}</p>}
        {error && <p class="flash err">{error}</p>}
        {children}
      </main>
      <footer class="foot">
        {actor ? `${actor.email} · ${actor.role}` : "Not signed in"} · Test mode — fictional jobs and test invoices only
      </footer>
    </body>
  </html>
);

export const Status: FC<{ status: string }> = ({ status }) => <span class={`badge s-${status}`}>{STATUS_LABELS[status] ?? status}</span>;

export const Field: FC<{ label: string; name: string; value?: string | number | null; type?: string; required?: boolean; hint?: string; rows?: number; step?: string; accept?: string; multiple?: boolean }> = (p) => (
  <label class="field">
    <span>
      {p.label}
      {p.required && " *"}
    </span>
    {p.rows ? (
      <textarea name={p.name} rows={p.rows} required={p.required}>
        {p.value ?? ""}
      </textarea>
    ) : (
      <input
        name={p.name}
        type={p.type ?? "text"}
        value={p.value === null || p.value === undefined ? undefined : String(p.value)}
        required={p.required}
        step={p.step}
        accept={p.accept}
        multiple={p.multiple}
        inputmode={p.type === "money" ? "decimal" : undefined}
      />
    )}
    {p.hint && <small>{p.hint}</small>}
  </label>
);

export const MoneyField: FC<{ label: string; name: string; value?: string; required?: boolean; hint?: string }> = (p) => (
  <label class="field">
    <span>
      {p.label}
      {p.required && " *"}
    </span>
    <input name={p.name} type="text" inputmode="decimal" placeholder="0.00" value={p.value} required={p.required} pattern="\$?[0-9,]+(\.[0-9]{1,2})?" />
    {p.hint && <small>{p.hint}</small>}
  </label>
);

/** A POST form carrying the job version for optimistic concurrency. */
export const ActionForm: FC<PropsWithChildren<{ action: string; version?: number; multipart?: boolean; class?: string }>> = ({ action, version, multipart, children, ...rest }) => (
  <form method="post" action={action} enctype={multipart ? "multipart/form-data" : undefined} class={rest.class}>
    {version !== undefined && <input type="hidden" name="version" value={String(version)} />}
    {children}
  </form>
);

export const Section: FC<PropsWithChildren<{ title: string; id?: string; note?: Child }>> = ({ title, id, note, children }) => (
  <section class="card" id={id}>
    <h2>{title}</h2>
    {note && <p class="muted">{note}</p>}
    {children}
  </section>
);

export const Yes: FC<{ ok: boolean; yes: string; no: string }> = ({ ok, yes, no }) => <span class={ok ? "yes" : "no"}>{ok ? `✔ ${yes}` : `✖ ${no}`}</span>;

export const CSS = `
:root{--bg:#f6f7f9;--fg:#15181d;--muted:#5d6672;--card:#fff;--line:#d9dee5;--accent:#1f5fbf;--ok:#1d7a3e;--warn:#9a6200;--err:#b3261e;--chip:#eef2f7}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8eaed;--muted:#a3abb6;--card:#1b1e23;--line:#30353d;--accent:#7fb0ff;--ok:#6fd08f;--warn:#f0b65a;--err:#ff8a80;--chip:#262b33}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
.brand{font-weight:700;text-decoration:none;color:var(--fg)}
nav{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center}nav a{text-decoration:none}
main{max-width:860px;margin:0 auto;padding:16px}
.foot{max-width:860px;margin:0 auto;padding:16px;color:var(--muted);font-size:13px}
h1{font-size:22px;margin:4px 0 12px}h2{font-size:17px;margin:0 0 10px}h3{font-size:15px;margin:14px 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:0 0 14px}
.muted,small{color:var(--muted)}small{display:block;font-size:13px;margin-top:2px}
.field{display:block;margin:0 0 12px}.field>span{display:block;font-weight:600;margin-bottom:4px}
input,textarea,select{width:100%;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input[type=file]{padding:8px}textarea{min-height:88px}
button,.btn{display:inline-block;font:inherit;font-weight:600;padding:11px 16px;min-height:44px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
button.secondary,.btn.secondary{background:transparent;color:var(--accent)}button.danger{background:var(--err);border-color:var(--err)}
button.link{background:none;border:0;color:var(--accent);padding:0;min-height:0;font-weight:400}
form.inline{display:inline}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.flash{padding:10px 12px;border-radius:8px;margin:0 0 14px}.flash.ok{background:color-mix(in srgb,var(--ok) 14%,transparent)}.flash.err{background:color-mix(in srgb,var(--err) 14%,transparent)}
.badge{display:inline-block;font-size:13px;padding:2px 8px;border-radius:999px;background:var(--chip)}
.s-blocked,.s-declined,.s-cancelled{color:var(--err)}.s-paid,.s-dispatched,.s-in_progress{color:var(--ok)}.s-approved,.s-quoted{color:var(--warn)}
.yes{color:var(--ok);font-weight:600}.no{color:var(--err);font-weight:600}
dl.kv{display:grid;grid-template-columns:minmax(110px,34%) 1fr;gap:4px 12px;margin:0}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
ul.plain{list-style:none;padding:0;margin:0}ul.plain>li{padding:8px 0;border-top:1px solid var(--line)}ul.plain>li:first-child{border-top:0}
.qcard{border:1px solid var(--line);border-radius:10px;padding:12px;margin:8px 0;background:var(--card)}
.qcard h3{margin:0 0 6px}.bucket{margin-bottom:18px}.bucket>h2 .count{color:var(--muted);font-weight:400}
.banner{padding:10px 12px;border-radius:8px;font-weight:700;letter-spacing:.02em;margin:0 0 12px;border:2px dashed var(--warn);color:var(--warn)}
.banner.issued{border-style:solid;border-color:var(--ok);color:var(--ok)}.banner.void{border-color:var(--err);color:var(--err)}
table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}td.num,th.num{text-align:right;white-space:nowrap}
.msg{padding:8px 10px;border-radius:8px;background:var(--chip);margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}.msg.internal{border-left:4px solid var(--warn)}
.provisional{border:2px solid var(--warn);border-radius:10px;padding:10px;margin-bottom:10px}
details>summary{cursor:pointer;font-weight:600;margin:6px 0}
@media print{.top,.foot,form,button{display:none!important}body{background:#fff;color:#000}.card{border:0}}
`;
