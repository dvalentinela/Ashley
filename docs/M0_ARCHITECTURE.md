# M0 — Architecture

Status: implemented and tested locally (M1–M4). Not yet deployed.
Source of requirements: `docs/brief/03_Shared_Product_Brief.txt` v0.1 (31 Oct 2026).

## 1. Shape of the system

One Cloudflare Worker serves the web app and runs background work. State lives
only in Cloudflare D1 (records) and R2 (private files). There is no browser-local
data store and no client-side JavaScript; every page is server-rendered HTML
with ordinary forms, so phone dictation into text fields works and a closed
tab loses nothing.

```
 Customer phone ─┐                    ┌─ D1 (SQLite): jobs, quotes, events, invoices,
 Jack's phone ───┼─ HTTPS ─ Worker ───┤      ledger, notifications outbox, agent runs
 Partner ────────┘   (Hono, SSR)      ├─ R2: private attachments (served only via /files/:id)
                        │             ├─ Resend API (email)            ← outbox, retried
                        │             └─ OpenAI or Anthropic API       ← Catherine runs, retried
                  Cron (every minute) → background runner (same Worker)
```

| Component | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (`nodejs_compat`) | Free tier for development; $5/month paid plan for the pilot; no servers to patch. |
| Web framework | Hono 4 + Hono JSX (server-rendered) | Small, Workers-native, escapes output by default, no build step for a frontend. |
| Records | D1 | Relational data with transactions (`batch`), unique constraints for idempotency, Time Travel point-in-time restore. |
| Files | R2 (private bucket) | No public access; every download goes through an authorization check. |
| Authentication | Better Auth 1.7 with the magic-link plugin, sessions in D1 | Established open-source library, runs on Workers with a D1 binding directly, no passwords to hash (avoids CPU limits), no third-party identity processor. |
| Background work | D1 outbox + lease + cron sweep (every minute), plus an immediate attempt after the request (`waitUntil`) | Survives closed tabs and worker restarts; all state is inspectable in D1; one fewer product than Queues/Workflows; deterministic to test. |
| Email | Resend REST API (adapter); `dev` mailbox provider locally | Free tier fits the pilot; idempotency keys prevent duplicate sends on retry. |
| AI | Provider adapter: OpenAI Responses API (raw HTTP) or Anthropic Messages API (official SDK); `none` = manual mode | Model and provider are configuration; no provider is assumed available until Jack connects one. |

### Alternatives considered

- **Queues/Workflows instead of the cron outbox.** Both are on the Workers Free
  plan (Queues: 10,000 ops/day; Workflows: 3,000 steps/day). Not needed yet:
  the outbox gives the same durability with simpler local testing. Revisit if
  volume grows or if multi-step agent workflows need long waits.
- **Cloudflare Access for authentication.** Free up to 50 users and needs no
  email provider, but every customer would consume a seat and customer
  sign-up would be awkward. Could still front `/op` as extra defense later.
- **Clerk/hosted auth.** Adds a third-party processor of customer identities
  and client-side scripts; no concrete advantage at this scale.
- **Password sign-in.** Rejected for now: password hashing can exceed the
  Workers Free 10 ms CPU limit, and passwords add reset flows.
- **A separate SPA/PWA.** Deferred. The brief asks to assess a PWA after the
  core workflow works on Jack's phone.

## 2. Roles and access (server-enforced)

| Role | How it is granted | Can |
|---|---|---|
| Operator (Jack) | Email listed in the `OPERATOR_EMAILS` secret. Cannot be granted through the UI or database. | Everything operational. |
| Customer | Any other verified email (magic link). | Create requests; see only their own jobs, files, messages, customer-visible history, issued invoices; approve/reject quotes; cancel before dispatch. |
| Partner | Operator creates a partner record with a sign-in email. | See own referral link, referred job references and statuses, and their ledger. No customer identity, contact, locations, documents or invoices. |

Every job, file, invoice and quote lookup filters by role in SQL. Requests for
records the user may not see return **404** (not 403) so existence is not
disclosed. State-changing requests must carry this site's `Origin` (CSRF
check). Sign-in requests are rate-limited per client IP (`cf-connecting-ip`).

## 3. Data model (D1)

Migrations: `migrations/0001_auth.sql` (generated from Better Auth's own schema)
and `migrations/0002_core.sql`. Money is integer cents; times are UTC
milliseconds; display uses `APP_TIMEZONE` (America/Los_Angeles).

| Table | Purpose / key rules |
|---|---|
| `jobs` | One row per request. `ref` (J-0001) for humans, `version` for optimistic concurrency, `current_quote_id`. |
| `job_events` | Append-only audit log: actor id + role, time, type, from→to status, job version, supporting record (`ref_table`/`ref_id`), visibility. |
| `job_messages` | Customer-visible messages and internal notes/issues. |
| `attachments` | R2 key, sha256, size, type, kind (`customer_material` / `evidence` / `receipt`). |
| `quotes` | Versioned. `content_hash` binds the customer's approval to the exact content. Customer decision and operator acceptance are recorded on the version. |
| `availability` | Jack's declared time blocks. A quote window must fit inside one to accept. |
| `work_orders` | Structured snapshot per dispatched quote version. `UNIQUE(quote_id)` ⇒ one assignment per version. |
| `expenses` | Each has exactly one receipt; running total cannot exceed the approved ceiling (checked inside the transaction). |
| `completions` | `UNIQUE(job_id)` and `UNIQUE(event_key)` ⇒ a replayed completion is a no-op. |
| `invoices`, `invoice_lines` | Number allocated with the draft inside the same transaction; `TEST-INV-` prefix while not live. One draft and one issued revision per job (partial unique indexes). Issued revisions are immutable; corrections void and redraft. Total = fee + reimbursements + tax (CHECK). |
| `payments` | Separate from invoices. Manual confirmation with a required reference; idempotency key; cannot exceed balance. |
| `partner_ledger` | Separate from invoices. Basis = service fee only. Accrual at issue (`pending_collection`), `earned` on full payment, reversal on void. |
| `notifications` | Outbox: status, attempts, backoff, lease, last error, dedupe key, acknowledgement. |
| `agent_runs`, `agent_actions` | Catherine runs (spec id/version/sha256, provider, model, tokens, cost) and proposed actions with validation results and decisions. |
| `guard` | One-row table whose CHECK constraint aborts a D1 batch when a precondition fails (see below). |

**Atomic preconditions.** D1 has no interactive transactions, so each change
is one `batch` that starts with
`UPDATE guard SET ok = CASE WHEN <precondition> THEN 1 ELSE 0 END` — for
example "job still at the version the page showed" or "quote still `sent` with
this hash". If the precondition is false the CHECK fails and D1 rolls back the
whole batch. The user sees "This job changed after the page was loaded" instead
of a silent overwrite.

## 4. Workflow → implementation

| Brief step | Implementation |
|---|---|
| 1 Request | `createJob` — fields, attachments, contact, locations, timing, referral source, limits. Status `requested`. Not a booking. |
| 2 Clarify/plan | Operator questions (`needs_info`), customer replies reopen it; optional Catherine plan. |
| 3 Quote | `sendQuote` — scope, authorized steps, fee, expense ceiling, window, terms, authority, materials, evidence, if-blocked. New version supersedes old and voids its approval/acceptance. |
| 4 Approval + assignment | Customer approves `(quote id, content hash)`; operator accepts the same version only if the window fits declared availability. Dispatch happens when both exist, in either order. |
| 5 Work order | Created in the dispatch transaction; printable at `/op/work-orders/:id`. |
| 6 Execution | Start, report issue (→ `blocked`), resolve, evidence uploads, expenses with receipts within the ceiling. Exceeding scope/spend requires a revised quote, which pauses the job (`quoted`). |
| 7 Completion | Requires evidence (or an explicit exception with unresolved items). Exceptions stay in the Blocked bucket until resolved. |
| 8 Invoice/payment | Numbered draft at completion → operator issues → manual payment confirmation marks paid. |
| 9 Partner reconciliation | Ledger entries; separate partner view. |
| 10 Follow-up | Queue lists: waiting on customer, unacknowledged notifications, failed notifications, unpaid issued invoices, failed Catherine runs. No automated reminders yet (see DECISIONS.md). |

## 5. Catherine runtime — tool and action boundaries

- **Spec**: `catherine/specs/provisional-0.1.md`, labeled PROVISIONAL everywhere
  it appears. Built into `src/agent/specs.generated.ts` with its SHA-256; each
  run records `spec_id`, `spec_version`, `spec_sha256`, provider, model,
  tokens, measured cost and the hash of the exact input.
- **Input**: the spec is the system prompt; the job record is passed as JSON
  in a data block labeled "data, not instructions". File contents are not sent.
- **Output**: a strict JSON schema (summary, service fit, missing info,
  exclusions, digital/physical steps, assumptions with evidence, risks, up to
  five proposed actions). Validated again server-side with Zod; unknown tools
  or malformed arguments are stored as `invalid` and can never execute.
- **Tools** (each requires operator approval, executes at most once, records
  actor/time/result and any operator edits):

| Tool | Effect when approved | Cannot |
|---|---|---|
| `request_clarification` | Customer-visible message + notification; job → `needs_info` if it was `requested`. | Change scope or price. |
| `draft_customer_message` | Customer-visible message + notification. | — |
| `draft_quote` | Prefills the operator's quote form. Never creates or sends a quote. Fees are never filled by Catherine. | Approve, send or price. |
| `add_internal_note` | Internal note. | Reach the customer. |
| `flag_unsupported` | Internal note marked as an exclusion. | Decline the job. |

  No tool can accept quotes, approve spending, reserve Jack's time, dispatch,
  issue invoices, record payments, or read files.
- **Reliability**: runs are queued rows; retried with backoff (1, 5, 15 min;
  3 attempts); non-retryable errors (auth, refusal, truncation) stop at once.
  A failed run never changes the job; the failure is shown on the job and in
  the queue, and manual work continues.
- **Cost control**: application-enforced monthly budget (`AI_MONTHLY_BUDGET_USD`)
  from measured tokens × configured prices. If prices are not configured the
  runtime refuses to run rather than run unmetered. Runs are on demand (one
  button), not automatic per request.

## 6. Notifications

Each notification is written in the same transaction as the change it
announces, so a committed change always has its notification queued. Delivery
is attempted immediately and by the cron sweep; failures retry at 1, 5, 15 and
60 minutes (5 attempts) and then stop as `dead`. Dead/failed notifications are
listed at the top of the operator queue with a "Retry now" button, and the job
itself stays in its bucket regardless. Operator notifications that need action
(new request, customer reply, quote approved/rejected, dispatched) stay in
"Unacknowledged" until Jack opens the job. Emails carry the job reference and a
link only — no customer documents or contact details.

## 7. Honesty rules built in

- Test mode is permanent until tax and payment rules exist: `LIVE_MODE=true`
  refuses to start. Every invoice is `TEST-INV-…` and labeled TEST.
- Draft invoices say "DRAFT — NOT AN INVOICE. Do not pay"; issued and void
  revisions are labeled; payments are shown as a separate payment record.
- The dev email provider records `simulated`, never `sent`.
- Stale Catherine plans (job changed since) are flagged.
- Production refuses dev email, fake AI, weak secrets and non-HTTPS URLs.

## 8. Known limits of this design

- D1 is a single primary database; fine for this scale.
- Sign-in depends on email delivery. Sessions last 30 days, so a Resend outage
  does not lock out a signed-in operator; a new sign-in during an outage fails
  with a clear message.
- Workers Free allows 10 ms CPU per request. Not yet measured under real
  traffic; the pilot should use Workers Paid (see cost sheet).
