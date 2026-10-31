# Operating instructions (test mode)

For Jack, on the phone. Everything here uses fictional customers and TEST
invoices until live operation is explicitly enabled.

## Daily loop

1. **Open the queue** (`/op`). Read top to bottom:
   - *Failed notifications* — someone did not get an email. Tap **Retry now**
     or contact them another way. The job is still in its bucket.
   - *Unacknowledged* — things you have not opened yet. Opening the job clears them.
   - *Needs decision* — new requests, customer replies, rejected quotes.
   - *Ready to accept* — customer approved; accept to dispatch.
   - *In progress* — dispatched or started.
   - *Blocked / open exceptions* — something went wrong; resolve it.
   - *Ready to invoice* — completed; a numbered DRAFT exists.
   - *Waiting on customer*, *Unpaid issued invoices*, *Catherine runs that failed*.
2. **Keep availability current** (`/op/availability`). You can only accept a
   job whose whole window fits inside one of your blocks.

## A job, start to finish

1. **Review the request.** Ask questions ("Ask for information"), or press
   "Ask Catherine for a plan" (PROVISIONAL helper: it only proposes; you
   approve or reject each proposal, and can edit text first), or decline.
2. **Send a quote**: scope, one authorized step per line, service fee,
   outside-expense ceiling, window, terms, evidence you will provide, what to do
   if blocked. Sending a new version cancels the old approval and acceptance.
3. **Accept.** You can pre-accept while waiting for the customer; the job
   dispatches as soon as they approve that exact version. If it is outside your
   availability the app refuses and the job stays pending.
4. **Dispatched**: open the work order (printable). Acknowledge by opening the job.
5. **Start** when you begin.
6. **During the work** (short updates and phone dictation work in every box):
   - *Report issue* for a closed office, absent recipient, wrong document — the
     job goes to Blocked and stays visible.
   - *Upload evidence* — e.g. a handoff photo.
   - *Record expense* — amount, what it was for, and a receipt photo. The app
     refuses anything that would exceed the approved ceiling: stop and send a
     revised quote instead.
7. **Complete**: describe what happened. Choose "completed with an unresolved
   exception" if something is still open (it stays in Blocked until you mark it
   resolved). Completing creates a numbered **DRAFT** invoice.
8. **Invoice**: open the draft, check it, **Issue**. The customer gets an email
   with a link. Issued invoices cannot be edited; use **Void and redraft** for
   corrections (before any payment is recorded).
9. **Payment**: only when payment is verified, record it with a reference.
   Completion is not payment.

## Notifications

- Email is the only channel. If an email fails it is retried after 1, 5, 15
  and 60 minutes, then listed under Failed notifications. The queue is the
  source of truth — check it even if no email arrived.
- Field test still needed: confirm notifications arrive on the Android phone
  while locked and away from Wi-Fi (brief, Field Connectivity).

## When something is down

| Problem | What you see | What to do |
|---|---|---|
| AI provider down or budget used | "Catherine unavailable: …" banner | Work manually; nothing else is affected. |
| Email provider down | Failed notifications; sign-in links cannot be sent | Existing sessions keep working (30 days). Contact customers directly; retry later. |
| "This job changed after the page was loaded" | Nothing was saved | Reload the job and redo the action. |
| A page error | "The request failed" | Reload the job to see its current state before retrying. |

## Backup and restore

- **Automatic**: D1 Time Travel keeps point-in-time history (7 days on Workers
  Free, 30 on Paid). R2 objects are durable but are not versioned by this app.
- **Manual export**: `npm run backup:remote` writes a full SQL dump (schema,
  data, migration history) to `backups/` (git-ignored). Store it privately —
  it contains customer records. `/op/export` downloads business records as JSON
  (no session tokens).
- **Restore into a new database** (tested locally on 31 Oct 2026, see
  `docs/evidence/local-e2e/restore-check.json`):
  1. `npx wrangler d1 create operator-db-restore`
  2. `npx wrangler d1 execute operator-db-restore --remote --file backups/<dump>.sql`
  3. `npx wrangler d1 execute operator-db-restore --remote --command 'DELETE FROM "rateLimit"; DELETE FROM "verification"; DELETE FROM "session";'`
  4. Point `wrangler.jsonc` at the restored database id and deploy (R2 objects
     are unchanged, so file links keep working).
  5. Run the access checks: owner can open their file; another customer and the
     partner get "not found"; customer gets 403 on `/op`.
- **Restore in place**: `npx wrangler d1 time-travel restore operator-db --timestamp=<unix-seconds>`
  then step 3 above.

## Before the first real customer (remaining conditions)

See `docs/MILESTONES.md` → "Conditions before a real customer pilot".
