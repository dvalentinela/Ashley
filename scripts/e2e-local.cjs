#!/usr/bin/env node
// Local end-to-end run of the FIRST TEST JOB across separate browser
// contexts (separate accounts/devices) at an Android phone viewport.
// Requires `npm run dev` (wrangler dev --test-scheduled) on BASE with
// EMAIL_PROVIDER=dev, AI_PROVIDER=fake and
// OPERATOR_EMAILS=jack@operator.test,backup-phone@fail.test in .dev.vars.
// Writes screenshots and a JSON log to docs/evidence/local-e2e/.
/* eslint-disable no-console */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://localhost:8787";
const OUT = path.join(__dirname, "..", "docs", "evidence", "local-e2e");
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const step = (name, detail = {}) => {
  log.push({ at: new Date().toISOString(), step: name, ...detail });
  console.log(`✔ ${name}`, Object.keys(detail).length ? JSON.stringify(detail) : "");
};
const fail = (msg) => {
  throw new Error(msg);
};
const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36" };

function laLocal(hoursFromNow) {
  const d = new Date(Date.now() + hoursFromNow * 3600_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function signIn(browser, email) {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.click('button[type="submit"]');
  await page.waitForSelector("text=Check your email");
  const html = await (await ctx.request.get(`${BASE}/dev/mailbox`)).text();
  const re = new RegExp(`to ${email.replace(/[.@]/g, (m) => `\\${m}`)}[\\s\\S]*?(http://\\S+?/api/auth/magic-link/verify\\S+?)[\\s<]`);
  const m = re.exec(html);
  if (!m) fail(`no sign-in mail for ${email}`);
  await page.goto(m[1].replace(/&amp;/g, "&"));
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}

async function submit(page, selector = 'button[type="submit"]') {
  await Promise.all([page.waitForNavigation(), page.click(selector)]);
}

(async () => {
  const browser = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "op-e2e-"));
  const docPath = path.join(tmp, "customer-document.pdf");
  fs.writeFileSync(docPath, "%PDF-1.4\n% fictional customer document for the first test job\n");
  const receiptPath = path.join(tmp, "test-receipt.png");
  const handoffPath = path.join(tmp, "handoff.png");
  // 1x1 PNGs stand in for phone photos.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(receiptPath, png);
  fs.writeFileSync(handoffPath, png);

  // --- Operator (Jack's phone) ---
  const op = await signIn(browser, "jack@operator.test");
  if (!op.page.url().endsWith("/op")) fail(`operator landed on ${op.page.url()}`);
  step("operator signed in (magic link)", { url: op.page.url() });

  await op.page.goto(`${BASE}/op/partners`);
  await op.page.fill('input[name="name"]', "Fourth Street Office (fictional)");
  await op.page.fill('input[name="login_email"]', "desk@fourth.test");
  await op.page.fill('input[name="share_percent"]', "20");
  await submit(op.page, 'form[action="/op/partners"] button');
  const refLink = await op.page.locator("dd", { hasText: "/r/" }).first().innerText();
  step("partner added with TEST 20% share", { refLink });

  await op.page.goto(`${BASE}/op/availability`);
  await op.page.fill('input[name="start"]', laLocal(-1));
  await op.page.fill('input[name="end"]', laLocal(48));
  await op.page.fill('input[name="note"]', "Pilot test block");
  await submit(op.page, 'form[action="/op/availability"] button');
  step("availability declared");

  // --- Customer (separate device) via referral link ---
  const custCtx = await browser.newContext(phone);
  const custPre = await custCtx.newPage();
  await custPre.goto(refLink.trim());
  const cust = await (async () => {
    // Reuse the context so the referral cookie is kept.
    const page = custPre;
    await page.fill('input[name="email"]', "fictional.customer@example.test");
    await submit(page);
    const html = await (await custCtx.request.get(`${BASE}/dev/mailbox`)).text();
    const m = /to fictional\.customer@example\.test[\s\S]*?(http:\/\/\S+?\/api\/auth\/magic-link\/verify\S+?)[\s<]/.exec(html);
    await page.goto(m[1].replace(/&amp;/g, "&"));
    return { ctx: custCtx, page };
  })();
  step("customer signed in through partner referral link");

  await cust.page.goto(`${BASE}/c/new`);
  await cust.page.fill('textarea[name="requested_outcome"]', "Print two sets of the attached document and deliver them to the reception desk.");
  await cust.page.fill('textarea[name="instructions"]', "Double-sided, stapled top-left.");
  await cust.page.fill('input[name="contact_method"]', "Email");
  await cust.page.fill('input[name="pickup_location"]', "Customer-supplied file (attached)");
  await cust.page.fill('input[name="destination"]', "Reception desk, 100 Example Plaza (fictional)");
  await cust.page.fill('input[name="destination_contact"]', "Front desk attendant (fictional)");
  await cust.page.fill('input[name="requested_timing"]', "Tomorrow late morning");
  await cust.page.fill('textarea[name="limits"]', "No more than $10 on printing.");
  await cust.page.setInputFiles('input[name="files"]', docPath);
  await shot(cust.page, "01-customer-new-request");
  await submit(cust.page, 'form[action="/c/jobs"] button');
  const jobUrl = cust.page.url().split("?")[0];
  const jobId = /\/jobs\/(job_[a-z0-9]+)/.exec(jobUrl)[1];
  const ref = (await cust.page.locator("h1").innerText()).split(" ")[0];
  await shot(cust.page, "02-customer-request-submitted");
  step("customer submitted request", { jobId, ref });

  // --- Operator sees it on another device ---
  await op.page.goto(`${BASE}/op`);
  if (!(await op.page.content()).includes(ref)) fail("job not visible in operator queue");
  await shot(op.page, "03-operator-queue-new-request");
  step("operator sees request in queue on separate session");

  await op.page.goto(`${BASE}/op/jobs/${jobId}`);
  await submit(op.page, `form[action="/op/jobs/${jobId}/plan"] button`);
  await op.page.waitForTimeout(1500);
  await op.page.goto(`${BASE}/op/jobs/${jobId}#catherine`);
  if (!(await op.page.content()).includes("Latest run:</strong> succeeded")) fail("Catherine plan not ready");
  await op.page.locator("#catherine").screenshot({ path: path.join(OUT, "04-operator-catherine-provisional-plan.png") });
  step("Catherine (PROVISIONAL, fake provider) produced a plan; actions await approval");

  // Send quote: $45 fee, $10 ceiling, window tomorrow.
  const form = op.page.locator(`form[action="/op/jobs/${jobId}/quote"]`);
  await form.locator('textarea[name="scope"]').fill("Print two sets of the customer-supplied document and deliver to the reception desk.");
  await form.locator('textarea[name="authorized_steps"]').fill("Print two double-sided stapled sets\nDeliver to the reception desk\nPhotograph the handoff");
  await form.locator('input[name="service_fee"]').fill("45.00");
  await form.locator('input[name="expense_ceiling"]').fill("10.00");
  await form.locator('input[name="window_start"]').fill(laLocal(20));
  await form.locator('input[name="window_end"]').fill(laLocal(22));
  await form.locator('textarea[name="terms"]').fill("TEST terms: free cancellation before dispatch.");
  await form.locator('input[name="completion_evidence"]').fill("Photo of handoff and print receipt");
  await Promise.all([op.page.waitForNavigation(), form.locator("button").click()]);
  step("operator sent quote v1 ($45 fee, $10 expense ceiling)");

  // --- Customer approves exact version ---
  await cust.page.goto(jobUrl);
  await shot(cust.page, "05-customer-quote-to-approve");
  await submit(cust.page, 'form[action$="/approve"] button');
  step("customer approved quote v1");

  // --- Operator accepts → dispatched ---
  await op.page.goto(`${BASE}/op`);
  await shot(op.page, "06-operator-ready-to-accept-card");
  await submit(op.page, `form[action="/op/jobs/${jobId}/accept"] button`);
  if (!(await op.page.content()).includes("Dispatched. Work order created.")) fail("not dispatched");
  step("operator accepted → dispatched with work order");
  const woHref = await op.page.locator('a[href^="/op/work-orders/"]').getAttribute("href");
  await op.page.goto(`${BASE}${woHref}`);
  await shot(op.page, "07-operator-work-order");

  // Field work.
  await op.page.goto(`${BASE}/op/jobs/${jobId}`);
  await submit(op.page, `form[action="/op/jobs/${jobId}/start"] button`);
  await op.page.setInputFiles(`form[action="/op/jobs/${jobId}/evidence"] input[name="files"]`, handoffPath);
  await op.page.fill(`form[action="/op/jobs/${jobId}/evidence"] input[name="note"]`, "Handed to front desk (fictional)");
  await submit(op.page, `form[action="/op/jobs/${jobId}/evidence"] button`);
  await op.page.fill(`form[action="/op/jobs/${jobId}/expense"] input[name="amount"]`, "6.50");
  await op.page.fill(`form[action="/op/jobs/${jobId}/expense"] input[name="description"]`, "Printing two sets (test receipt)");
  await op.page.setInputFiles(`form[action="/op/jobs/${jobId}/expense"] input[name="receipt"]`, receiptPath);
  await submit(op.page, `form[action="/op/jobs/${jobId}/expense"] button`);
  step("started; evidence and $6.50 receipt recorded");

  // Complete, capturing the form's event key to replay it.
  const cform = op.page.locator(`form[action="/op/jobs/${jobId}/complete"]`);
  const eventKey = await cform.locator('input[name="event_key"]').inputValue();
  const version = await cform.locator('input[name="version"]').inputValue();
  await cform.locator('textarea[name="summary"]').fill("Two sets delivered to the reception desk; handoff photographed.");
  await shot(op.page, "08-operator-field-updates");
  await Promise.all([op.page.waitForNavigation(), cform.locator("button").click()]);
  step("operator confirmed completion");

  // Replay the identical completion event (duplicate delivery).
  const replay = await op.ctx.request.post(`${BASE}/op/jobs/${jobId}/complete`, {
    headers: { origin: BASE },
    form: { version, event_key: eventKey, summary: "Two sets delivered to the reception desk; handoff photographed.", outcome: "completed" },
    maxRedirects: 0,
  });
  const replayLoc = replay.headers()["location"] || "";
  if (!replayLoc.includes("completed_duplicate")) fail(`duplicate completion not detected: ${replay.status()} ${replayLoc}`);
  step("duplicate completion event → no second invoice", { status: replay.status(), location: replayLoc });

  const invHref = await op.page.locator('a[href^="/op/invoices/"]').first().getAttribute("href");
  await op.page.goto(`${BASE}${invHref}`);
  const draftText = await op.page.content();
  if (!draftText.includes("DRAFT — NOT AN INVOICE") || !draftText.includes("$51.50")) fail("draft invoice wrong");
  await shot(op.page, "09-operator-draft-invoice");
  await submit(op.page, 'form[action$="/issue"] button');
  await shot(op.page, "10-operator-issued-invoice");
  const invNumber = (await op.page.locator("h1").innerText()).split("\n")[0];
  step("invoice issued", { invNumber, total: "$51.50" });

  // Customer sees the issued TEST invoice.
  await cust.page.goto(`${BASE}${invHref.replace("/op/", "/c/")}`);
  const custInv = await cust.page.content();
  if (!custInv.includes("TEST INVOICE") || !custInv.includes("$51.50")) fail("customer invoice wrong");
  await shot(cust.page, "11-customer-test-invoice");
  step("customer sees issued TEST invoice $51.50");

  // Partner view.
  const partner = await signIn(browser, "desk@fourth.test");
  await partner.page.goto(`${BASE}/p`);
  const pv = await partner.page.content();
  if (!pv.includes(ref) || !pv.includes("$9.00")) fail("partner ledger wrong");
  if (pv.includes("fictional.customer@example.test") || pv.includes("100 Example Plaza")) fail("partner sees customer details");
  await shot(partner.page, "12-partner-referrals-ledger");
  step("partner sees referral + $9.00 TEST share, no customer details");

  // Access denial checks across accounts.
  const other = await signIn(browser, "other.customer@example.test");
  const fileHref = await op.page.goto(`${BASE}/op/jobs/${jobId}`).then(() => op.page.locator('a[href^="/files/"]').first().getAttribute("href"));
  const denials = {
    otherCustomerJob: (await other.ctx.request.get(`${BASE}/c/jobs/${jobId}`)).status(),
    otherCustomerFile: (await other.ctx.request.get(`${BASE}${fileHref}`)).status(),
    otherCustomerInvoice: (await other.ctx.request.get(`${BASE}${invHref.replace("/op/", "/c/")}`)).status(),
    partnerFile: (await partner.ctx.request.get(`${BASE}${fileHref}`)).status(),
    partnerOperatorPage: (await partner.ctx.request.get(`${BASE}/op/jobs/${jobId}`)).status(),
    customerOperatorQueue: (await cust.ctx.request.get(`${BASE}/op`)).status(),
    ownerFile: (await cust.ctx.request.get(`${BASE}${fileHref}`)).status(),
  };
  if (denials.otherCustomerJob !== 404 || denials.otherCustomerFile !== 404 || denials.otherCustomerInvoice !== 404 || denials.partnerFile !== 404 || denials.partnerOperatorPage !== 403 || denials.customerOperatorQueue !== 403 || denials.ownerFile !== 200) {
    fail(`access checks failed ${JSON.stringify(denials)}`);
  }
  step("access checks", denials);

  // Payment confirmation.
  await op.page.goto(`${BASE}${invHref}`);
  await op.page.fill('input[name="reference"]', "TEST payment ref 0001");
  await submit(op.page, 'form[action$="/payment"] button');
  step("manual TEST payment confirmation recorded → paid; partner share earned");

  // Failed-notification recovery: notifications to backup-phone@fail.test fail.
  await (await op.ctx.request.get(`${BASE}/__scheduled?cron=*+*+*+*+*`)).text();
  await op.page.goto(`${BASE}/op`);
  const q = await op.page.content();
  if (!q.includes("Failed notifications")) fail("failed notifications not shown");
  await op.page.locator("section", { hasText: "Failed notifications" }).screenshot({ path: path.join(OUT, "13-operator-failed-notifications.png") });
  await submit(op.page, 'form[action^="/op/notifications/"] button');
  if (!(await op.page.content()).includes("Notification queued for another attempt.")) fail("retry not queued");
  step("failed notification visible with retry; operator re-queued one");

  await op.page.goto(`${BASE}/op/jobs/${jobId}`);
  await shot(op.page, "14-operator-job-audit-history");

  fs.writeFileSync(path.join(OUT, "run-log.json"), JSON.stringify({ base: BASE, jobId, ref, invoice: invNumber, steps: log }, null, 2));
  await browser.close();
  console.log(`\nAll steps passed. Evidence in ${OUT}`);
})().catch(async (err) => {
  console.error("E2E FAILED:", err.message);
  fs.writeFileSync(path.join(OUT, "run-log.json"), JSON.stringify({ error: err.message, steps: log }, null, 2));
  process.exit(1);
});
