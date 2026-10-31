# Decisions needed and proposed changes

Business decisions belong to Jack (with the strategy project's review). The
software uses explicit test placeholders until each is decided; none of these
were decided silently.

## A. Unresolved business decisions (blocking real customers)

| # | Decision | Current placeholder in the software | What changes once decided |
|---|---|---|---|
| A1 | Public business name and domain | `workers.dev` URL; sender `onboarding@resend.dev` | Domain verified in Resend; `APP_URL`, `EMAIL_FROM` set. |
| A2 | Rate card, minimum charge, cancellation rules | Operator types any fee and terms per quote; quote form says "TEST values only" | Optional rate-card helper and default terms text. |
| A3 | Expense handling (reimburse at cost? markup? receipts?) | Reimbursed at cost, one receipt per expense required, capped by the approved ceiling | Rule text in quotes/invoices; markup line if chosen. |
| A4 | Tax treatment for these services in California | Tax line $0, labeled "Tax not configured — test invoice"; `LIVE_MODE` cannot be enabled | Tax configuration (rates, which lines are taxable) implemented and tested before live invoices. Needs a qualified tax answer, not a developer's guess. |
| A5 | Partner agreement | 20% test share of service fee, excluding reimbursements; accrues at invoice issue, earned when fully paid, reversed on void; labeled "TEST POLICY" | Real rate, earning event, refund treatment, payout cadence. |
| A6 | Jack's service hours, travel radius, task limits | Availability blocks Jack enters; nothing else enforced | Default availability; service-area check on intake. |
| A7 | Data retention for customer documents | Kept indefinitely in private R2 | Scheduled deletion (e.g. N days after paid) and a customer-facing notice. |
| A8 | AI provider and model for Catherine | `AI_PROVIDER=none` (manual mode) | Provider key + model + prices configured; measured per-job cost reported. |
| A9 | Approved Catherine specification | `provisional-0.1`, labeled PROVISIONAL | New spec file added; `AGENT_SPEC_ID` switched; tests updated. |
| A10 | Reminder policy for follow-up items | Queue lists only; no automated reminders | Scheduled reminders with limits (e.g. one reminder per unpaid invoice after N days). |
| A11 | Refunds and credit notes | Not implemented; payments cannot be reversed in the app; issued invoices with payments cannot be revised | Credit-note flow and partner-ledger reversal for refunds. |
| A12 | Payment collection | Manual confirmation with reference only | Provider in test mode after A3/A4/A11 are explicit. |

## B. Implementation choices that have a practical effect (proposed — please confirm or change)

| # | Choice made | Practical effect | Alternative |
|---|---|---|---|
| B1 | Customers must sign in (email link) before submitting a request. | Every request has a verified contact and a private history; first-time customers need one extra step. | Anonymous intake with email verification later. |
| B2 | Jack may **pre-accept** a quote before the customer approves; the job then dispatches the moment the customer approves that exact version. | Fewer round trips. Pre-acceptance is void if the quote changes. | Require acceptance only after approval. |
| B3 | Any quote revision, including during work, voids the previous approval and acceptance and pauses the job until both are given again. | Scope/spend/time changes always return for approval, as the brief requires. Jack must re-accept. | Allow small changes without re-acceptance. |
| B4 | Acceptance requires the whole quoted window to fit inside one declared availability block. | Requests outside Jack's availability stay pending (brief criterion D). Jack must keep availability current. | Warn instead of block. |
| B5 | Completion requires at least one evidence file, unless recorded as "completed with exception" with the unresolved item described. | Proof exists for every normal completion. | Allow completion without evidence. |
| B6 | The invoice number is allocated when the draft is created (at completion). Discarded drafts would remain visible as void, never reused. | Gap-free, auditable numbering; numbers appear in draft order. | Allocate the number only at issue. |
| B7 | Corrections void the issued revision and create revision N+1 under the same number. | Customer sees "INV-00012 rev 2"; full history kept. | Credit note plus new number. |
| B8 | Opening a job acknowledges its pending operator notifications. | "Unacknowledged" means "Jack has not looked at it". | Separate explicit Acknowledge button. |
| B9 | Catherine runs only when Jack presses "Ask Catherine for a plan". | Cost and attention stay under Jack's control. | Automatic plan on every new request. |
| B10 | Sign-in is by emailed link only (no passwords). Sessions last 30 days. Sign-in requests are limited to 5 per 10 minutes per IP address. | Depends on email delivery; a shared office network could hit the limit if many customers sign in at once. | Add passkeys for Jack; tune the limit. |
| B11 | Partners see job references and statuses only. | No customer data leaves Jack's view. | Show more (e.g. first names) if the agreement requires it. |

## C. Open questions for Jack

1. Will Jack's Resend account use the same email address he wants as the
   operator sign-in (`OPERATOR_EMAILS`)? Before a domain is verified, Resend can
   only email that one address.
2. Does Jack's ChatGPT subscription show API credits under Settings → Billing →
   API credits? If yes, which API organization should receive them?
3. Should a second, backup operator address receive notifications (e.g. a
   different inbox on the phone)?
