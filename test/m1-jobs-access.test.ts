import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, FIRST_JOB, OPERATOR, jobIdFrom, pdf, signIn } from "./helpers";

describe("M1 — authentication and roles", () => {
  it("assigns operator only from OPERATOR_EMAILS; everyone else is a customer", async () => {
    const op = await signIn(OPERATOR);
    const cust = await signIn("alice@customer.test");
    expect((await op.get("/")).headers.get("location")).toBe("/op");
    expect((await cust.get("/")).headers.get("location")).toBe("/c");
    expect((await cust.get("/op")).status).toBe(403);
    expect((await op.get("/c")).status).toBe(403);
    expect((await new Client().get("/op")).status).toBe(403);
  });

  it("rejects cross-site form posts (CSRF)", async () => {
    const cust = await signIn("csrf@customer.test");
    const { SELF } = await import("cloudflare:test");
    const raw = await SELF.fetch("http://localhost/c/jobs", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: [...cust.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: new FormData(),
      redirect: "manual",
    });
    expect(raw.status).toBe(403);
  });
});

describe("M1 — durable job system", () => {
  it("customer submits on one device; operator sees it on another; history persists across sign-out", async () => {
    const alice = await signIn("alice2@customer.test");
    const loc = await alice.ok("/c/jobs", { ...FIRST_JOB, files: pdf("brief.pdf") });
    const id = jobIdFrom(loc);

    const row = await env.DB.prepare("SELECT ref, status, version FROM jobs WHERE id = ?").bind(id).first<{ ref: string; status: string; version: number }>();
    expect(row).toMatchObject({ status: "requested", version: 1 });
    expect(row!.ref).toMatch(/^J-\d{4}$/);

    // Operator on a different "device" (separate cookie jar / session).
    const op = await signIn(OPERATOR);
    const queue = await op.html("/op");
    expect(queue).toContain(row!.ref);
    const detail = await op.html(`/op/jobs/${id}`);
    expect(detail).toContain("brief.pdf");
    expect(detail).toContain("job.created");

    // Operator edits (internal note) persist; sign out and back in.
    await op.ok(`/op/jobs/${id}/message`, { version: 1, body: "Checked the file: 3 pages.", visibility: "internal" });
    await op.ok("/logout", {});
    expect((await op.get("/op")).status).toBe(403);
    const op2 = await signIn(OPERATOR);
    const again = await op2.html(`/op/jobs/${id}`);
    expect(again).toContain("Checked the file: 3 pages.");
    expect(again).toContain("note.added");

    // The customer never sees internal notes.
    const custView = await alice.html(`/c/jobs/${id}`);
    expect(custView).not.toContain("Checked the file");
  });

  it("enforces customer isolation for jobs and files; partners get no files", async () => {
    const alice = await signIn("alice3@customer.test");
    const bob = await signIn("bob@customer.test");
    const id = jobIdFrom(await alice.ok("/c/jobs", { ...FIRST_JOB, files: pdf("private.pdf", "%PDF secret contents") }));
    const att = await env.DB.prepare("SELECT id, r2_key FROM attachments WHERE job_id = ?").bind(id).first<{ id: string; r2_key: string }>();

    // Owner can download; the object really is in R2.
    const own = await alice.get(`/files/${att!.id}`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("%PDF secret contents");
    expect(own.headers.get("content-security-policy")).toContain("sandbox");

    // Another customer gets 404 for job, file, and job-scoped actions.
    expect((await bob.get(`/c/jobs/${id}`)).status).toBe(404);
    expect((await bob.get(`/files/${att!.id}`)).status).toBe(404);
    expect((await bob.post(`/c/jobs/${id}/message`, { version: 1, body: "hi" })).status).toBe(404);
    expect((await bob.get("/c")).status).toBe(200);
    expect(await bob.html("/c")).not.toContain(id);

    // Anonymous: no file.
    expect((await new Client().get(`/files/${att!.id}`)).status).toBe(403);

    // Partner: no files, no customer job pages, no operator tools.
    const op = await signIn(OPERATOR);
    await op.ok("/op/partners", { name: "Fourth Street Office (fictional)", login_email: "partner@office.test", share_percent: "20" });
    const partner = await signIn("partner@office.test");
    expect((await partner.get("/")).headers.get("location")).toBe("/p");
    expect((await partner.get(`/files/${att!.id}`)).status).toBe(404);
    expect((await partner.get(`/c/jobs/${id}`)).status).toBe(403);
    expect((await partner.get(`/op/jobs/${id}`)).status).toBe(403);
    expect((await partner.post(`/op/jobs/${id}/quote`, { version: 1 })).status).toBe(403);
  });

  it("rejects disallowed file types and oversize-style abuse without storing anything", async () => {
    const carol = await signIn("carol@customer.test");
    const res = await carol.post("/c/jobs", { ...FIRST_JOB, files: new File(["<script>alert(1)</script>"], "x.html", { type: "text/html" }) });
    expect(res.status).toBe(415);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE customer_id = (SELECT id FROM \"user\" WHERE email = ?)").bind("carol@customer.test").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("validates required fields and reports stale edits instead of overwriting", async () => {
    const dan = await signIn("dan@customer.test");
    expect((await dan.post("/c/jobs", { ...FIRST_JOB, requested_outcome: "" })).status).toBe(422);
    const id = jobIdFrom(await dan.ok("/c/jobs", FIRST_JOB));
    const op = await signIn(OPERATOR);
    await op.ok(`/op/jobs/${id}/message`, { version: 1, body: "first", visibility: "internal" });
    // A second form loaded at version 1 must not silently apply.
    const stale = await op.post(`/op/jobs/${id}/message`, { version: 1, body: "second", visibility: "internal" });
    expect(stale.status).toBe(409);
  });
});
