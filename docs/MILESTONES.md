# Milestones — plan and status (31 Oct 2026)

"Done locally" = implemented and verified by automated tests and a local
browser run. Nothing is deployed yet; no real email, AI call, or payment has
been made.

| Milestone | Status | Evidence | Remaining |
|---|---|---|---|
| M0 Architecture + costed plan | Done | `docs/M0_ARCHITECTURE.md`, `docs/M0_COST_SHEET.md`, `docs/DECISIONS.md` | Jack's decisions in DECISIONS.md |
| M1 Durable job system | Done locally | `test/m1-jobs-access.test.ts` (7 tests); local run steps 1–6 | Deployed check on two real devices |
| M2 Quote + human dispatch | Done locally | `test/m2-quote-dispatch.test.ts` (7 tests); local run | **Real** test notification (needs Cloudflare + Resend + domain) |
| M3 Catherine runtime | Done locally with a deterministic fake model | `test/m3-catherine.test.ts` (6 tests) | Approved spec; a real provider key; measured cost per job; plan-quality review |
| M4 Completion + invoices | Done locally | `test/m4-first-test-job.test.ts` (4 tests) — the brief's first test job | Tax rules, refunds/credit notes (decisions A4, A11) |
| M5 Pilot handoff | Partly done locally | `docs/evidence/local-e2e/` (14 screenshots, run log, restore check) | Deployed run on Jack's Android phone; real notification while locked/off Wi-Fi; remote backup/restore drill |

## Brief acceptance evidence (A–L)

| # | Criterion | Status |
|---|---|---|
| A | Persistence across devices | Local: separate sessions/contexts; deployed check pending. |
| B | Access isolation | Tested (jobs, files, invoices, partner limits, operator-only tools) — locally and after restore. |
| C | Approval before dispatch/extra spend | Tested (exact-version approval, revisions pause work, expense ceiling). |
| D | Outside availability stays pending | Tested. |
| E | No duplicate assignments/invoices/charges | Tested (duplicate accept, completion replay, payment replay). |
| F | Honesty (AI down, failures, stale data) | Tested (dead runs, stale-version conflicts, dead notifications, simulated ≠ sent). |
| G | Real test notification + failure/retry | Retry/failure tested; **real delivery pending accounts**. |
| H | Accounting separation | Tested ($45 + $6.50 = $51.50; tax $0 labeled; $9 test partner share; payment separate). |
| I | Backup/restore with access intact | Done locally (`restore-check.json`); remote drill pending. |
| J | Phone usability on Jack's Android | Rendered at 412×915 phone viewport locally; **real device test pending**. |
| K | Audit of consequential changes | Tested (actor, time, version, supporting record). |
| L | Jack owns repo, hosting, data, billing | Repo is Jack's; hosting accounts to be created by Jack (SETUP.md). |

## Next implementation steps

1. Deploy to Jack's Cloudflare account (after SETUP.md §2–3); real sign-in and
   notification tests; CPU-time check on Workers Free.
2. Verify a domain in Resend; run the full first test job on two real devices
   (Jack's Android + a second device), including the locked-phone/off-Wi-Fi
   notification test and a remote backup/restore drill.
3. Connect the chosen AI provider with a $5 budget; measure cost and quality
   per job on fictional requests; replace the provisional spec when supplied.
4. PWA assessment (installable icon, offline queue view) after the field test.
5. Implement decisions as they arrive: tax configuration, reminder policy,
   refunds/credit notes, data retention, partner terms.

## Conditions before a real customer pilot

- Deployed on Workers Paid; domain verified; real notifications confirmed on the
  phone while locked and off Wi-Fi.
- Decisions A2–A5, A7 made and implemented; `LIVE_MODE` support (tax lines,
  invoice prefix `INV-`) built and tested.
- Approved Catherine spec, or `AI_PROVIDER=none`.
- A privacy/terms notice for customers that names the processors used
  (Cloudflare, Resend, the AI provider if enabled).
- Remote backup/restore drill completed with access checks.
