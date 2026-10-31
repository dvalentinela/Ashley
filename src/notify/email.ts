import type { AppConfig, Env } from "../env";
import { newId } from "../lib/db";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export interface EmailResult {
  /** 'sent' = accepted by a real provider; 'simulated' = dev mailbox only. */
  status: "sent" | "simulated";
  provider: string;
  providerMessageId: string | null;
}

export class EmailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Resend transactional email (https://resend.com/docs/api-reference/emails/send-email). */
export async function sendViaResend(
  apiKey: string,
  from: string,
  msg: EmailMessage,
  fetchImpl: FetchLike = fetch,
): Promise<EmailResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Resend de-duplicates retries carrying the same key for 24 hours.
        "Idempotency-Key": msg.idempotencyKey,
      },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new EmailError(`Network error contacting Resend: ${err instanceof Error ? err.name : "unknown"}`, true);
  }
  if (!res.ok) {
    // Keep the provider's message (it never contains our API key) but cap it.
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    throw new EmailError(`Resend HTTP ${res.status}: ${body}`, retryable);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { status: "sent", provider: "resend", providerMessageId: data.id ?? null };
}

/**
 * Development/test provider: stores the message in dev_mailbox and reports
 * 'simulated' (never 'sent'). Recipients at the reserved domain fail.test
 * fail on purpose so retry behavior can be demonstrated locally.
 */
async function sendViaDevMailbox(env: Env, msg: EmailMessage): Promise<EmailResult> {
  if (msg.to.toLowerCase().endsWith("@fail.test")) {
    throw new EmailError("Simulated delivery failure (fail.test recipient)", true);
  }
  await env.DB.prepare("INSERT INTO dev_mailbox (id, recipient, subject, body_text, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(newId("mail"), msg.to.toLowerCase(), msg.subject, msg.text, Date.now())
    .run();
  return { status: "simulated", provider: "dev", providerMessageId: null };
}

export async function sendEmail(env: Env, cfg: AppConfig, msg: EmailMessage): Promise<EmailResult> {
  switch (cfg.emailProvider) {
    case "resend":
      if (!env.RESEND_API_KEY) throw new EmailError("RESEND_API_KEY is not configured", false);
      return sendViaResend(env.RESEND_API_KEY, cfg.emailFrom, msg);
    case "dev":
      return sendViaDevMailbox(env, msg);
    case "disabled":
      throw new EmailError("Email delivery is disabled (EMAIL_PROVIDER=disabled)", false);
  }
}
