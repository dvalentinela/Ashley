import { env, SELF } from "cloudflare:test";
import { runDueWork } from "../src/background";

export const BASE = "http://localhost";
export const OPERATOR = "jack@operator.test";

/** Minimal browser stand-in: keeps cookies, sends our Origin, never follows redirects. */
export class Client {
  cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET") headers.set("origin", BASE);
    const res = await SELF.fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (!value || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get(path: string) {
    return this.fetch(path);
  }

  post(path: string, data: Record<string, string | number | File | File[] | undefined>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((f) => fd.append(k, f));
      else fd.append(k, v instanceof File ? v : String(v));
    }
    return this.fetch(path, { method: "POST", body: fd });
  }

  /** POST and assert a redirect; returns the Location. */
  async ok(path: string, data: Record<string, string | number | File | File[] | undefined>): Promise<string> {
    const res = await this.post(path, data);
    if (res.status !== 303 && res.status !== 302) {
      const body = await res.text();
      const msg = /class="flash err">([^<]+)</.exec(body)?.[1] ?? body.slice(0, 300);
      throw new Error(`POST ${path} → ${res.status}: ${msg}`);
    }
    return res.headers.get("location")!;
  }

  async html(path: string): Promise<string> {
    const res = await this.get(path);
    if (res.status !== 200) throw new Error(`GET ${path} → ${res.status}`);
    return res.text();
  }
}

/** Signs in through the real magic-link flow using the dev mailbox. */
export async function signIn(email: string): Promise<Client> {
  const c = new Client();
  const res = await c.post("/login", { email });
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const mail = await env.DB.prepare("SELECT body_text FROM dev_mailbox WHERE recipient = ? AND subject LIKE '%sign-in%' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(email.toLowerCase())
    .first<{ body_text: string }>();
  const link = /https?:\/\/\S+/.exec(mail!.body_text)![0];
  const verify = await c.get(link.replace(BASE, ""));
  if (verify.status !== 302 && verify.status !== 303) throw new Error(`verify failed ${verify.status}`);
  if (![...c.cookies.keys()].some((k) => k.includes("session_token"))) throw new Error("no session cookie set");
  return c;
}

export function pdf(name = "document.pdf", body = "%PDF-1.4 test document"): File {
  return new File([body], name, { type: "application/pdf" });
}

export function jpeg(name = "photo.jpg"): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], name, { type: "image/jpeg" });
}

export function jobIdFrom(location: string): string {
  return /\/jobs\/(job_[a-z0-9]+)/.exec(location)![1]!;
}

/** "YYYY-MM-DDTHH:mm" in America/Los_Angeles, `hours` from now, rounded to the hour. */
export function laLocal(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 3600_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

export async function job(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<Record<string, unknown> & { status: string; version: number; current_quote_id: string | null }>();
}

export async function currentQuote(jobId: string) {
  return env.DB.prepare("SELECT q.* FROM quotes q JOIN jobs j ON j.current_quote_id = q.id WHERE j.id = ?").bind(jobId).first<{ id: string; content_hash: string; version: number; status: string }>();
}

export async function drain(now = Date.now()) {
  return runDueWork(env, now);
}

export const FIRST_JOB = {
  requested_outcome: "Print two sets of the attached document and deliver them to the reception desk.",
  instructions: "Double-sided, stapled top-left.",
  contact_method: "Email",
  pickup_location: "Customer-supplied file (attached)",
  destination: "Reception desk, 100 Example Plaza (fictional)",
  destination_contact: "Front desk attendant (fictional)",
  requested_timing: "Tomorrow between 10am and noon",
  limits: "Do not spend more than $10 on printing.",
};

export function quoteForm(version: number, overrides: Record<string, string> = {}) {
  return {
    version,
    scope: "Print two sets of the customer-supplied document and deliver to the reception desk.",
    authorized_steps: "Print two double-sided stapled sets\nDeliver to the reception desk\nPhotograph the handoff",
    service_fee: "45.00",
    expense_ceiling: "10.00",
    window_start: laLocal(24),
    window_end: laLocal(26),
    terms: "TEST terms: free cancellation before dispatch.",
    completion_evidence: "Photo of handoff and print receipt",
    if_blocked: "Stop and report; keep the documents secure.",
    ...overrides,
  };
}

/** Customer submits, operator quotes, customer approves, operator accepts. Returns the dispatched job id. */
export async function dispatchedJob(customer: Client, op: Client, opts: { availability?: boolean } = {}) {
  const loc = await customer.ok("/c/jobs", { ...FIRST_JOB, files: pdf() });
  const id = jobIdFrom(loc);
  if (opts.availability !== false) await op.ok("/op/availability", { start: laLocal(-1), end: laLocal(72), note: "test block" });
  await op.ok(`/op/jobs/${id}/quote`, quoteForm((await job(id))!.version));
  const q = await currentQuote(id);
  await customer.ok(`/c/quotes/${q!.id}/approve`, { content_hash: q!.content_hash, note: "" });
  await op.ok(`/op/jobs/${id}/accept`, { version: (await job(id))!.version, quote_id: q!.id });
  return id;
}
