# Setup, deployment and rollback

Everything below is owned by Jack: the GitHub repository, the Cloudflare
account, the Resend account, any AI API account, and the domain. Never paste
keys or tokens into a chat (ChatGPT, Claude, or Claude Code). Use the secure
places named in each step.

## 1. Local development (no accounts needed)

Requirements: Node 22+.

```sh
npm ci
cp .dev.vars.example .dev.vars        # then edit: set BETTER_AUTH_SECRET (openssl rand -hex 32)
                                     # and OPERATOR_EMAILS=you@example.com
npm run db:migrate:local
npm run dev                          # http://localhost:8787
```

- Email is not sent locally: open http://localhost:8787/dev/mailbox to read
  sign-in links and notifications (marked "simulated").
- Catherine: set `AI_PROVIDER=fake` plus `AI_PRICE_INPUT_USD_PER_MTOK=1` and
  `AI_PRICE_OUTPUT_USD_PER_MTOK=5` in `.dev.vars` for a deterministic local
  planner, or leave `none` for manual mode.
- Any address at `@fail.test` simulates failed email delivery.
- Checks: `npm run typecheck`, `npm test` (34 tests, run inside workerd).
- Browser walk-through: with `npm run dev` running and
  `OPERATOR_EMAILS=jack@operator.test,backup-phone@fail.test`, `AI_PROVIDER=fake`
  on a fresh local database, run `npm run e2e:local`.

## 2. Accounts Jack creates (free)

1. **Cloudflare** — https://dash.cloudflare.com/sign-up. Free plan. Note the
   Account ID (dashboard → Workers & Pages → right sidebar).
2. **Resend** — https://resend.com/signup using the **same email address Jack
   will use as the operator sign-in**. Until a domain is verified, Resend can
   only send to that one address. Create an API key with "Sending access" only.
3. **AI provider (optional)** — check ChatGPT Settings → Billing → API credits
   first. Otherwise either an OpenAI API organization or an Anthropic Console
   account with a small prepaid balance. Create a key restricted to this use.

## 3. First deployment

Two options. Option A keeps all credentials on Jack's own computer.

**Option A — Jack's computer**

```sh
git clone <repo> && cd <repo> && npm ci
npx wrangler login                                  # opens the browser, Jack approves
npx wrangler d1 create operator-db                  # copy the database_id it prints
#   → put that id in wrangler.jsonc (d1_databases[0].database_id) and commit
npx wrangler r2 bucket create operator-files
npx wrangler d1 migrations apply operator-db --remote
```

**Option B — a Claude Code cloud session deploys.** Jack creates a Cloudflare
API token (dashboard → My Profile → API Tokens → Create Token → "Edit
Cloudflare Workers" template, plus D1 Edit and Workers R2 Storage Edit, scoped
to this one account) and stores it in the Claude Code environment settings
(cloud environment menu → Edit → environment variables / network secrets) as
`CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID` alongside. A new session
can then run the same commands. Revoke the token when not needed.

**Set production configuration** (in `wrangler.jsonc` `vars` or with
`--var` — non-secret):

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `APP_URL` | `https://operator-service.<subdomain>.workers.dev` (or the custom domain) |
| `EMAIL_PROVIDER` | `resend` |
| `EMAIL_FROM` | `Operator <onboarding@resend.dev>` until a domain is verified; then e.g. `Operator <jobs@yourdomain>` |
| `AI_PROVIDER` / `AI_MODEL` | `none` / empty until chosen; e.g. `anthropic` / `claude-haiku-5-5`, or `openai` / a model id from the pricing page |
| `AI_PRICE_INPUT_USD_PER_MTOK`, `AI_PRICE_OUTPUT_USD_PER_MTOK` | The chosen model's current prices (required before Catherine will run) |
| `AI_MONTHLY_BUDGET_USD` | e.g. `5` |
| `LIVE_MODE` | `false` (the app refuses `true` until tax/payment rules exist) |

Recommended: keep `wrangler.jsonc` vars for development and put production
values in an `env.production` block, or pass them in CI. Do not commit secrets.

**Set secrets** (each command prompts for the value; nothing is echoed or stored in git):

```sh
npx wrangler secret put BETTER_AUTH_SECRET     # output of: openssl rand -hex 32
npx wrangler secret put OPERATOR_EMAILS        # jack@… (comma-separate a backup address)
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY      # or OPENAI_API_KEY, only if AI is enabled
```

**Deploy:** `npm run deploy` (runs type check and tests first, then `wrangler deploy`).
The cron trigger (every minute) is created by the deploy.

**First checks after deploy**

1. Open `APP_URL/login`, sign in as Jack → lands on `/op`.
2. `/op/system` shows `production`, email `resend`, live mode OFF, spec PROVISIONAL.
3. Jack's sign-in email arriving on his phone is the first real delivery
   through Resend. A real **job notification** needs a test customer at a
   second address, and Resend will not email a second address until a domain
   is verified (section 4). So the full M2/M5 notification evidence is:
   verify domain → sign in as a test customer from a second address on a
   second device → submit → Jack's phone (locked, off Wi-Fi) receives
   "New request J-…" → tap the link → the job opens and leaves
   "Unacknowledged".
4. Set a billing notification in Cloudflare (Notifications → Billing).

## 4. Domain and sender (pilot)

1. Choose the public business name; buy the domain (Cloudflare Registrar shows
   the price at checkout).
2. In Resend → Domains, add the domain and create the DNS records it lists
   (SPF/DKIM). Wait for "Verified".
3. Set `EMAIL_FROM` to an address on that domain; optionally route the domain
   to the Worker (Workers → Settings → Domains & Routes) and update `APP_URL`.
4. Redeploy.

## 5. Upgrading to Workers Paid (before real customers)

Dashboard → Workers & Pages → Plans → Workers Paid ($5/month minimum). Effects:
30 s CPU per request instead of 10 ms, 30-day D1 Time Travel instead of 7, no
daily request cap. No code change.

## 6. Releasing changes safely

1. CI must be green (GitHub Actions runs type check + tests on every push).
2. Before applying a migration to production:
   `npm run backup:remote` (writes `backups/operator-db-<timestamp>.sql`, git-ignored;
   store it somewhere private) and note the current time for Time Travel.
3. `npm run db:migrate:remote`, then `npm run deploy`.

Migrations are forward-only and additive. Never edit an applied migration.

## 7. Rollback

- **Code**: `npx wrangler deployments list` then `npx wrangler rollback <version-id>`
  (or Dashboard → Workers → operator-service → Deployments → Rollback). Takes
  effect in seconds.
- **Data**: `npx wrangler d1 time-travel restore operator-db --timestamp=<unix-seconds>`
  restores the database to a point in time (destructive: it overwrites the
  current database; up to 7 days back on Free, 30 on Paid). Export first if
  unsure: `npm run backup:remote`.
- After a data restore, clear ephemeral auth state so stale sign-in links and
  rate-limit counters do not carry over:
  `npx wrangler d1 execute operator-db --remote --command 'DELETE FROM "rateLimit"; DELETE FROM "verification";'`
  (optionally also `DELETE FROM "session";` to force everyone to sign in again).
- **Kill switch for AI**: set `AI_PROVIDER=none` and redeploy; everything else keeps working.
- **Kill switch for email**: set `EMAIL_PROVIDER=disabled`; notifications queue
  and show as failed, jobs stay in the queue. (Sign-in links then cannot be sent.)

## 8. Regenerating the auth schema

`migrations/0001_auth.sql` was generated from Better Auth 1.7.14's own schema
(magic-link plugin, database rate limiting, `role`/`partnerId` fields). When
upgrading Better Auth, regenerate with its `getMigrations()` helper and add any
difference as a new migration.
