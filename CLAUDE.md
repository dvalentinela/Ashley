# CLAUDE.md — Operator service

You are the external developer for **Operator**: an AI agent service with
authorized digital capabilities and a trained human (Jack, the owner) it can
dispatch for physical work. Requirements live in `docs/brief/` (brief v0.1,
31 Oct 2026). Read `docs/brief/03_Shared_Product_Brief.txt` before changing
behavior. Project knowledge from Claude.ai chats is not available here unless
it is copied into `docs/`.

## Boundaries (from the development assignment)

- Do not change the business model, rates, partner terms, service hours or
  permissions silently. Record proposals in `docs/DECISIONS.md` with their
  practical effect.
- Catherine: only `catherine/specs/` holds operating instructions. The current
  spec is PROVISIONAL and must stay labeled as such. Do not invent Catherine's
  personality or history, and never import Jack's private conversation archive.
- A customer request is not blanket authority, quote acceptance, or a booking
  of Jack's time. Dispatch requires customer approval of the exact quote
  version **and** operator acceptance.
- Model output is a proposal until a system record or verified tool result
  shows execution. Agent tools never approve, dispatch, invoice or take money.
- Draft invoices, issued invoices and payment records stay distinct.
- Test customers and test payments only; `LIVE_MODE=true` is refused by design.
- No secrets in code, git history, logs, screenshots or handoff text. Name the
  secret and where it is set (`wrangler secret put …`, environment settings).
- Report blockers plainly; do not claim deployments, emails, AI calls or tests
  that did not happen.

## Stack

Cloudflare Workers + D1 + R2, Hono (server-rendered JSX, no client JS),
Better Auth (magic link), cron-driven outbox for email (Resend) and Catherine
runs (OpenAI or Anthropic adapters). See `docs/M0_ARCHITECTURE.md`.

## Commands

```sh
npm ci                      # .npmrc sets legacy-peer-deps (needed by the test plugin)
npm run typecheck
npm test                    # vitest inside workerd; regenerates the spec module first
npm run dev                 # local server; /dev/mailbox shows simulated email
npm run e2e:local           # browser walk-through (see docs/SETUP.md §1)
```

## Conventions

- Every state change: one `runBatch` starting with a `guard`/`jobVersionGuard`
  statement, bumping `jobs.version`, writing a `job_events` row with actor,
  and queuing notifications in the same batch.
- Money in integer cents; times in UTC ms; display in `APP_TIMEZONE`.
- Lookups the actor may not see return 404. All role checks are server-side.
- Hono route regex alternations: put longer names first (`resolve-exception|resolve`).
- After editing `catherine/specs/*.md`, run `npm run build:specs` and commit the
  regenerated `src/agent/specs.generated.ts` (CI checks it is in sync).
- New schema changes go in a new numbered migration; never edit an applied one.
- Each milestone report goes in `docs/reports/` with the 7-part format from
  `docs/brief/02_Claude_Development_Project.txt`.
