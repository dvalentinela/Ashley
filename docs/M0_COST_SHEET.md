# M0 — Cost sheet

Prices fetched from vendor pages on **31 Oct 2026**. "Verified" means read from
the vendor's own pricing page on that date, not a quote for Jack's account.
Taxes/fees on vendor bills were **not** verified (they depend on billing address).
Nothing has been purchased, and no paid plan has been activated.

## 1. Verified vendor prices

| Vendor / plan | Verified price and limits (31 Oct 2026) | Source |
|---|---|---|
| Cloudflare Workers Free | $0. 100,000 requests/day; **10 ms CPU per invocation**; 5 cron triggers/account. | developers.cloudflare.com/workers/platform/pricing (page dated 2 Oct 2026), …/limits |
| Cloudflare Workers Paid | **$5/month minimum per account.** Includes 10M requests/month (+$0.30/M) and 30M CPU-ms/month (+$0.02/M CPU-ms); 30 s CPU default per request; 250 cron triggers. | same |
| D1 | Free: 5M rows read/day, 100k rows written/day, 5 GB. Paid: 25B reads/month, 50M writes/month, 5 GB included; then $0.001/M reads, $1.00/M writes, $0.75/GB-month. Time Travel restore: 7 days (Free) / 30 days (Paid), no extra charge. | …/workers/platform/pricing, developers.cloudflare.com/d1/reference/time-travel |
| R2 (Standard) | Free: 10 GB-month, 1M Class A, 10M Class B per month. Then $0.015/GB-month, $4.50/M Class A, $0.36/M Class B. Egress free. | …/workers/platform/pricing |
| Queues / Workflows | Not used. Free: Queues 10,000 ops/day; Workflows 3,000 steps/day. | same |
| Resend Free | $0. 3,000 emails/month, **100/day**, 3 domains, 30-day retention. | resend.com/pricing |
| Resend Pro | $20/month for 50,000 emails (no daily cap); overage $0.90 per 1,000. | resend.com/pricing |
| Resend test sender | `onboarding@resend.dev` can send **only to the Resend account's own address**; other recipients need a verified domain. | resend.com/docs/knowledge-base/403-error-resend-dev-domain |
| Anthropic API | Claude Haiku 5.5 $0.10 in / $0.50 out per MTok (≤100k-token prompts); Sonnet 5.5 $2 / $10; Opus 5.5 $4 / $20. | platform.claude.com/docs/en/about-claude/pricing |
| OpenAI API | As displayed: gpt-5-nano $0.05 / $0.40; gpt-5-mini $0.25 / $2.00; gpt-6-luna $0.10 / $0.50; gpt-5.4-mini $0.75 / $4.50 per MTok (standard tier). Read through an automated page summary — re-check on the page before choosing. | developers.openai.com/api/docs/pricing |
| ChatGPT → API credit benefit | Pro: $100/$200/$500 per month by tier; Business: per-seat, pooled. Subscription must be paid and ≥7 days old; credits go to one linked API organization; **unused credits expire at the end of the billing cycle**. Jack's eligibility is **not** verified. | developers.openai.com/api/docs/guides/chatgpt-api-credits |
| GitHub private repository + Actions | Using the existing repository `dvalentinela/Ashley`. GitHub Actions minutes for private repos depend on Jack's GitHub plan — not verified. | — |

## 2. Estimates (not vendor quotes)

**Catherine cost per run** — estimated from the actual prompt sizes in this
repository: spec 3,275 characters + job record ≈ 1,100 characters + output
schema → roughly **1,500–3,000 input tokens**; plan output plus model reasoning
→ roughly **1,000–4,000 output tokens**. Upper-bound cost per run (3k in / 4k out):

| Model | Upper-bound per run | 180 runs/month (60 jobs × 3 runs) |
|---|---|---|
| OpenAI gpt-5-nano | ≈ $0.002 | ≈ $0.32 |
| Claude Haiku 5.5 / OpenAI gpt-6-luna | ≈ $0.0023 | ≈ $0.41 |
| OpenAI gpt-5-mini | ≈ $0.009 | ≈ $1.58 |
| Claude Sonnet 5.5 | ≈ $0.046 | ≈ $8.28 |
| Claude Opus 5.5 | ≈ $0.092 | ≈ $16.56 |

These are estimates. The app records real tokens and cost for every run
(`/op/system` and each job's Catherine panel), so the first live runs replace
these numbers with measured cost per job. Model quality for this task is not
yet measured; pick by measured plan quality per dollar, not by price alone.

**Email volume** — about 8–12 emails per job (sign-in links, quote, approval,
dispatch, completion, invoice). Resend Free's 100/day cap therefore supports
roughly 8–12 jobs per day.

**Domain** — the planning allowance of $15–25/year is not a quote.
Cloudflare Registrar sells at registry cost; the actual price appears at
checkout once a name is chosen.

## 3. What to buy, when

| Item | Purpose | Existing alternative | When | Recurring | Trigger to buy | Low-cost fallback |
|---|---|---|---|---|---|---|
| Cloudflare account | Hosting, D1, R2, cron | — | **Now (free)** | $0 | Before first deployment | — |
| Resend account | Real email (sign-in links, notifications) | Jack's mailbox can receive test sends from `onboarding@resend.dev` | **Now (free)** | $0 | First real notification test (M2 evidence) | — |
| Workers Paid | 30 s CPU (vs 10 ms), 30-day Time Travel, no daily request cap | Workers Free | **For pilot** | $5/month minimum + usage (estimated $0 usage at pilot scale) | Before the first real customer, or earlier if CPU-limit errors appear | Stay on Free for staging |
| Domain | Customer-facing URL; required for Resend to email anyone except Jack | `*.workers.dev` URL | **For pilot** | Registry price/year (quote needed) | After the public business name is chosen | Use `workers.dev` and test only with Jack's address |
| AI API usage | Catherine plans | Manual mode (`AI_PROVIDER=none`) works fully | **For pilot (optional)** | Small; app-enforced budget, default $5/month | After checking ChatGPT API credits; or a small prepaid Anthropic/OpenAI balance | Keep manual mode |
| Resend Pro | Above 100 emails/day | Free tier | Optional later | $20/month | Sustained >8–12 jobs/day | — |
| Payment processor | Card payments | Manual payment confirmation | Optional later | Per-transaction fees (not priced) | After invoice/tax/refund rules are decided | Manual confirmation |
| SMS / business phone | Faster alerts | Email + operator queue | Optional later | Not priced | Field test shows email alerts are missed | — |

**Planning total for the pilot** (excluding chat subscriptions, phone service,
taxes, payment fees and field expenses): Cloudflare $5/month + Resend $0 +
AI ≈ $0.50–$5/month (budget-capped) + domain amortized ≈ $1–2/month →
**≈ $6.50–12/month**, inside the $5–25 target. This is an estimate.

## 4. Overage and failure policy

- **AI**: hard stop in the application at `AI_MONTHLY_BUDGET_USD` (default $5).
  Provider-side alerts are not relied on as a stop. When the stop is reached,
  or the provider fails, the app says so and manual review continues.
- **Email**: on Resend Free, sends above 100/day fail; failed notifications are
  retried, then listed in the queue for manual retry. Resend overage billing is
  opt-in and stays off.
- **Cloudflare**: on Free, requests over 100k/day fail; on Paid, usage above
  the included amounts is billed at the rates above. A billing notification
  should be set in the Cloudflare dashboard.
- **Storage**: files are capped at 10 MB each (5 per upload). R2 Free covers
  10 GB.
