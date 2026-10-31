import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { createAuth, resolveActor, type Actor } from "./auth";
import { runDueWork } from "./background";
import { authorizeDownload } from "./domain/files";
import { partnerReferrals } from "./domain/jobs";
import { config, ConfigError, type Env } from "./env";
import { AppError } from "./lib/errors";
import { formatMoney, formatTime, STATUS_LABELS } from "./lib/format";
import { customer } from "./web/customer";
import { operator } from "./web/operator";
import { CSS, Field, Layout, Section } from "./web/ui";

type C = { Bindings: Env; Variables: { actor: Actor | null } };
const app = new Hono<C>();

app.onError((err, c) => {
  const actor = c.get("actor") ?? null;
  if (err instanceof AppError) {
    return c.html(
      <Layout title="Not completed" actor={actor} error={err.message}>
        <p>
          <a href="/">Home</a>
        </p>
      </Layout>,
      err.status,
    );
  }
  if (err instanceof ConfigError) {
    console.error("configuration error", err.message);
    return c.text(`Service misconfigured: ${err.message}`, 500);
  }
  console.error("unhandled error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  return c.html(
    <Layout title="Error" actor={actor} error="The request failed. Reload the page to see the current state of the job before retrying.">
      <a href="/">Home</a>
    </Layout>,
    500,
  );
});

// Validate configuration on every request (cached) and set security headers.
app.use("*", async (c, next) => {
  config(c.env);
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  }
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

// Better Auth endpoints (magic-link verify, session, sign-out).
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

// CSRF: state-changing requests must come from our own origin.
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin !== config(c.env).origin) throw new AppError(403, "Request blocked: it did not come from this site.");
  }
  await next();
});

app.use("*", async (c, next) => {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  c.set("actor", session ? resolveActor(c.env, session.user as { id: string; email: string; name: string; role?: string; partnerId?: string }) : null);
  await next();
});

app.get("/app.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" }));

app.get("/", (c) => {
  const actor = c.get("actor");
  if (!actor) return c.redirect("/login", 302);
  return c.redirect(actor.role === "operator" ? "/op" : actor.role === "partner" ? "/p" : "/c", 302);
});

app.get("/login", (c) =>
  c.html(
    <Layout title="Sign in" actor={null} flash={c.req.query("ok")}>
      <h1>Sign in to Operator</h1>
      <p class="muted">Enter your email. We will send a sign-in link that works for 15 minutes. New customers get an account automatically.</p>
      <form method="post" action="/login" class="card">
        <Field label="Email" name="email" type="email" required />
        <button type="submit">Email me a sign-in link</button>
      </form>
    </Layout>,
  ),
);

app.post("/login", async (c) => {
  const cfg = config(c.env);
  const body = await c.req.parseBody();
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new AppError(422, "Enter a valid email address.");
  // Forward to Better Auth's own endpoint so its validation and rate limits apply.
  const headers = new Headers({ "content-type": "application/json", origin: cfg.origin });
  const ip = c.req.header("cf-connecting-ip");
  if (ip) headers.set("cf-connecting-ip", ip);
  const res = await createAuth(c.env).handler(
    new Request(`${cfg.appUrl}/api/auth/sign-in/magic-link`, { method: "POST", headers, body: JSON.stringify({ email, callbackURL: "/" }) }),
  );
  if (res.status === 429) throw new AppError(422, "Too many sign-in requests. Wait a few minutes and try again.");
  if (!res.ok) {
    console.error("magic link request failed", res.status);
    throw new AppError(503, "The sign-in email could not be sent right now. Try again shortly.");
  }
  return c.html(
    <Layout title="Check your email" actor={null}>
      <h1>Check your email</h1>
      <p>If {email} can receive email, a sign-in link is on its way. It expires in 15 minutes.</p>
      {cfg.emailProvider === "dev" && (
        <p class="flash err">
          Development mode: no email is sent. Open the <a href="/dev/mailbox">local dev mailbox</a>.
        </p>
      )}
    </Layout>,
  );
});

app.post("/logout", async (c) => {
  const res = await createAuth(c.env).api.signOut({ headers: c.req.raw.headers, asResponse: true });
  const out = c.redirect("/login?ok=signed_out", 303);
  for (const cookie of res.headers.getSetCookie()) out.headers.append("Set-Cookie", cookie);
  return out;
});

// Referral links set a short-lived cookie used when the customer submits.
app.get("/r/:code{[a-z0-9]{4,16}}", (c) => {
  setCookie(c, "op_ref", c.req.param("code"), { httpOnly: true, sameSite: "Lax", secure: config(c.env).appUrl.startsWith("https://"), maxAge: 30 * 24 * 3600, path: "/" });
  return c.redirect("/login", 302);
});

app.get("/files/:id", async (c) => {
  const actor = c.get("actor");
  if (!actor) throw new AppError(403, "Sign in first.");
  const row = await authorizeDownload(c.env, actor, c.req.param("id"));
  const obj = await c.env.FILES.get(row.r2_key);
  if (!obj) throw new AppError(404, "File content is missing from storage.");
  const inline = row.content_type.startsWith("image/") || row.content_type === "application/pdf";
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});

app.get("/dev/mailbox", async (c) => {
  if (config(c.env).env === "production") throw new AppError(404, "Not found");
  const rows = await c.env.DB.prepare("SELECT recipient, subject, body_text, created_at FROM dev_mailbox ORDER BY created_at DESC LIMIT 30").all<{ recipient: string; subject: string; body_text: string; created_at: number }>();
  const tz = config(c.env).timezone;
  return c.html(
    <Layout title="Dev mailbox" actor={c.get("actor")}>
      <h1>Local dev mailbox</h1>
      <p class="flash err">Development only. These messages were NOT sent by a real email provider.</p>
      {rows.results.map((m) => (
        <Section title={m.subject}>
          <small>
            to {m.recipient} · {formatTime(m.created_at, tz)}
          </small>
          <pre class="msg">{m.body_text}</pre>
          {(() => {
            const link = /https?:\/\/\S+/.exec(m.body_text)?.[0];
            return link ? <a href={link.replace(/^https?:\/\/[^/]+/, "")}>Open link</a> : null;
          })()}
        </Section>
      ))}
    </Layout>,
  );
});

app.route("/c", customer);
app.route("/op", operator);

app.get("/p", async (c) => {
  const actor = c.get("actor");
  const { jobs, ledger, partner } = await partnerReferrals(c.env, actor!);
  const tz = config(c.env).timezone;
  const cfg = config(c.env);
  return c.html(
    <Layout title="Referrals" actor={actor}>
      <h1>{partner?.name} — referrals</h1>
      <p class="banner">No partner agreement exists yet. Amounts below are TEST calculations ({partner?.policy_label}).</p>
      <Section title="Your referral link">
        <code>
          {cfg.appUrl}/r/{partner?.ref_code}
        </code>
      </Section>
      <Section title="Referred jobs" note="You see only job references and status. Customer details and documents are private.">
        <ul class="plain">
          {jobs.map((j) => (
            <li>
              {j.ref} — {STATUS_LABELS[j.status] ?? j.status} <small>referred {formatTime(j.created_at, tz)}</small>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Ledger (separate from customer invoices)">
        <table>
          <tbody>
            {ledger.map((l) => (
              <tr>
                <td>
                  {l.ref} · {l.number} · {l.entry_type} · {l.status.replace("_", " ")}
                  <small>
                    {(l.rate_bps / 100).toFixed(2)}% of service fee {formatMoney(l.basis_cents)} (reimbursements excluded)
                  </small>
                </td>
                <td class="num">{formatMoney(l.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </Layout>,
  );
});

app.notFound((c) => c.html(<Layout title="Not found" actor={c.get("actor") ?? null} error="Page not found." />, 404));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runDueWork(env).then((r) => {
        if (Object.keys(r.notifications).length || Object.keys(r.runs).length) console.log("background", JSON.stringify(r));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
