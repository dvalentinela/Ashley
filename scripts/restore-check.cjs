#!/usr/bin/env node
// Verifies a restored instance: records, files and access controls survive a
// backup/restore. Run against a server started from the restored database
// (see docs/OPERATIONS.md "Backup and restore"). Uses the job created by
// scripts/e2e-local.cjs (read from docs/evidence/local-e2e/run-log.json).
/* eslint-disable no-console */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://localhost:8788";
const OUT = path.join(__dirname, "..", "docs", "evidence", "local-e2e");
const run = JSON.parse(fs.readFileSync(path.join(OUT, "run-log.json"), "utf8"));

async function signIn(browser, email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button')]);
  if (!(await page.content()).includes("Check your email")) throw new Error(`sign-in refused for ${email}`);
  const html = await (await ctx.request.get(`${BASE}/dev/mailbox`)).text();
  const re = new RegExp(`to ${email.replace(/[.@]/g, (m) => `\\${m}`)}[\\s\\S]*?(http://\\S+?/api/auth/magic-link/verify\\S+?)[\\s<]`);
  const link = re.exec(html)[1].replace(/&amp;/g, "&");
  await page.goto(link);
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch();
  const results = {};
  const op = await signIn(browser, "jack@operator.test");
  const jobPage = await (await op.ctx.request.get(`${BASE}/op/jobs/${run.jobId}`)).text();
  results.operatorSeesJob = jobPage.includes(run.ref) && jobPage.includes("Paid");
  results.auditEvents = (jobPage.match(/<tr><td><small>/g) || []).length;
  const invoiceHref = /href="(\/op\/invoices\/inv_[a-z0-9]+)"/.exec(jobPage)[1];
  const inv = await (await op.ctx.request.get(`${BASE}${invoiceHref}`)).text();
  results.invoiceIntact = inv.includes(run.invoice) && inv.includes("$51.50") && inv.includes("TEST payment ref 0001");
  const fileHref = /href="(\/files\/att_[a-z0-9]+)"/.exec(jobPage)[1];
  const cust = await signIn(browser, "fictional.customer@example.test");
  results.ownerFile = (await cust.ctx.request.get(`${BASE}${fileHref}`)).status();
  const other = await signIn(browser, "other.customer@example.test");
  results.otherCustomerJob = (await other.ctx.request.get(`${BASE}/c/jobs/${run.jobId}`)).status();
  results.otherCustomerFile = (await other.ctx.request.get(`${BASE}${fileHref}`)).status();
  const partner = await signIn(browser, "desk@fourth.test");
  results.partnerFile = (await partner.ctx.request.get(`${BASE}${fileHref}`)).status();
  const pv = await (await partner.ctx.request.get(`${BASE}/p`)).text();
  results.partnerLedgerEarned = pv.includes("$9.00") && pv.includes("earned");
  results.customerOperatorQueue = (await cust.ctx.request.get(`${BASE}/op`)).status();
  await browser.close();
  const ok =
    results.operatorSeesJob && results.invoiceIntact && results.partnerLedgerEarned && results.ownerFile === 200 && results.otherCustomerJob === 404 && results.otherCustomerFile === 404 && results.partnerFile === 404 && results.customerOperatorQueue === 403;
  fs.writeFileSync(path.join(OUT, "restore-check.json"), JSON.stringify({ base: BASE, checked_at: new Date().toISOString(), ok, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(ok ? "RESTORE CHECK PASSED" : "RESTORE CHECK FAILED");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("RESTORE CHECK ERROR", e.message);
  process.exit(1);
});
