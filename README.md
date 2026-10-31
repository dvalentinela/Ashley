# Operator

An AI agent service that performs supported, authorized digital work and can
dispatch a trained human operator for physical work. This repository is the
operating system for it: customer requests, quotes, approvals, dispatch, field
evidence, invoices, partner reconciliation, and a provisional AI planning role
("Catherine") that only proposes actions for the operator to approve.

**Status (31 Oct 2026):** M0–M4 implemented and tested locally; M5 partly
prepared. Not deployed. Test mode only — fictional customers and TEST invoices.
Latest report: [`docs/reports/2026-10-31_M0-M4_report.md`](docs/reports/2026-10-31_M0-M4_report.md).

| Document | Contents |
|---|---|
| [docs/M0_ARCHITECTURE.md](docs/M0_ARCHITECTURE.md) | Components, data model, roles, Catherine tool boundaries |
| [docs/M0_COST_SHEET.md](docs/M0_COST_SHEET.md) | Verified prices (31 Oct 2026), estimates, what to buy when |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Business decisions needed; implementation choices to confirm |
| [docs/MILESTONES.md](docs/MILESTONES.md) | Milestone status, acceptance evidence A–L, next steps |
| [docs/SETUP.md](docs/SETUP.md) | Local dev, accounts, deployment, secrets, rollback |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Phone workflow, failures, backup and restore |
| [docs/brief/](docs/brief/) | The source brief and assignment (v0.1) |
| [catherine/](catherine/) | Versioned Catherine specs (currently PROVISIONAL only) |

## Quick start (local, no accounts)

```sh
npm ci
cp .dev.vars.example .dev.vars   # set BETTER_AUTH_SECRET and OPERATOR_EMAILS
npm run db:migrate:local
npm run dev                      # http://localhost:8787 ; sign-in links at /dev/mailbox
npm test                         # 33 tests inside the Workers runtime
```

## Layout

```
src/index.tsx          routes: auth, files, partner view, cron entry
src/web/               server-rendered pages (customer, operator, shared)
src/domain/            jobs, quotes/dispatch, billing, files, audit events
src/agent/             Catherine runtime, providers, generated spec module
src/notify/            email providers and the notification outbox
migrations/            D1 schema
catherine/specs/       operating instructions (kept apart from code)
test/                  vitest suites (M1–M4 + config)
scripts/               spec builder, local e2e, restore check
```
