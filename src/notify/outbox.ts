import { config, type Env } from "../env";
import { newId } from "../lib/db";
import { EmailError, sendEmail } from "./email";

export interface NotificationInput {
  jobId: string | null;
  recipientUserId: string | null;
  recipientEmail: string;
  template: string;
  subject: string;
  body: string;
  linkPath: string | null;
  requiresAck?: boolean;
  dedupeKey: string;
}

/** Retry delays after attempt n (1-based): 1, 5, 15, 60 minutes. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const LEASE_MS = 60_000;

/**
 * Returns the INSERT for a notification so it can be committed in the same
 * batch as the state change it announces. Duplicate dedupe keys are ignored.
 */
export function notificationInsert(db: D1Database, n: NotificationInput, now = Date.now()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO notifications
        (id, job_id, recipient_user_id, recipient_email, template, subject, body_text, link_path,
         status, attempts, max_attempts, next_attempt_at, dedupe_key, requires_ack, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?, ?)`,
    )
    .bind(
      newId("ntf"),
      n.jobId,
      n.recipientUserId,
      n.recipientEmail.toLowerCase(),
      n.template,
      n.subject,
      n.body,
      n.linkPath,
      now,
      n.dedupeKey,
      n.requiresAck ? 1 : 0,
      now,
    );
}

/** Notifications for every configured operator address. */
export function operatorNotifications(
  env: Env,
  base: Omit<NotificationInput, "recipientEmail" | "recipientUserId" | "dedupeKey"> & { dedupeKey: string },
  now = Date.now(),
): D1PreparedStatement[] {
  return config(env).operatorEmails.map((email) =>
    notificationInsert(env.DB, { ...base, recipientEmail: email, recipientUserId: null, dedupeKey: `${base.dedupeKey}:${email}` }, now),
  );
}

interface NotificationRow {
  id: string;
  recipient_email: string;
  subject: string;
  body_text: string;
  link_path: string | null;
  attempts: number;
  max_attempts: number;
}

/**
 * Claims and delivers one notification. Safe to call concurrently (from the
 * request's waitUntil and from the cron sweep): the lease ensures one sender.
 */
export async function deliverNotification(env: Env, id: string, now = Date.now()): Promise<string | null> {
  const cfg = config(env);
  const claimed = await env.DB.prepare(
    `UPDATE notifications SET status = 'sending', lease_until = ?, attempts = attempts + 1
      WHERE id = ? AND next_attempt_at <= ?
        AND (status IN ('pending', 'failed') OR (status = 'sending' AND lease_until < ?))
      RETURNING id, recipient_email, subject, body_text, link_path, attempts, max_attempts`,
  )
    .bind(now + LEASE_MS, id, now, now)
    .first<NotificationRow>();
  if (!claimed) return null;

  const link = claimed.link_path ? `${cfg.appUrl}${claimed.link_path}` : null;
  const text = link ? `${claimed.body_text}\n\nOpen: ${link}\n` : claimed.body_text;
  try {
    const result = await sendEmail(env, cfg, {
      to: claimed.recipient_email,
      subject: claimed.subject,
      text,
      idempotencyKey: `ntf:${claimed.id}`,
    });
    await env.DB.prepare(
      `UPDATE notifications SET status = ?, sent_at = ?, provider = ?, provider_message_id = ?, lease_until = NULL, last_error = NULL
        WHERE id = ?`,
    )
      .bind(result.status, Date.now(), result.provider, result.providerMessageId, claimed.id)
      .run();
    return result.status;
  } catch (err) {
    const retryable = err instanceof EmailError ? err.retryable : true;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const exhausted = !retryable || claimed.attempts >= claimed.max_attempts;
    const delay = BACKOFF_MS[Math.min(claimed.attempts - 1, BACKOFF_MS.length - 1)] ?? 60_000;
    await env.DB.prepare(
      `UPDATE notifications SET status = ?, last_error = ?, next_attempt_at = ?, lease_until = NULL WHERE id = ?`,
    )
      .bind(exhausted ? "dead" : "failed", message, now + delay, claimed.id)
      .run();
    return exhausted ? "dead" : "failed";
  }
}

export async function dueNotificationIds(env: Env, now = Date.now(), limit = 25): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id FROM notifications
      WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
         OR (status = 'sending' AND lease_until < ?)
      ORDER BY next_attempt_at LIMIT ?`,
  )
    .bind(now, now, limit)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

/** Operator-triggered retry of a failed or dead notification. */
export async function retryNotification(env: Env, id: string, actorId: string): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT job_id, status, attempts FROM notifications WHERE id = ?")
    .bind(id)
    .first<{ job_id: string | null; status: string; attempts: number }>();
  if (!row || (row.status !== "dead" && row.status !== "failed")) return;
  const stmts = [
    env.DB.prepare(
      `UPDATE notifications SET status = 'pending', next_attempt_at = ?, max_attempts = attempts + 3, last_error = last_error
        WHERE id = ? AND status IN ('dead', 'failed')`,
    ).bind(now, id),
  ];
  if (row.job_id) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO job_events (id, job_id, created_at, actor_id, actor_role, type, job_version, ref_table, ref_id, detail)
         SELECT ?, ?, ?, ?, 'operator', 'notification.retry_requested', version, 'notifications', ?, '{}' FROM jobs WHERE id = ?`,
      ).bind(newId("evt"), row.job_id, now, actorId, id, row.job_id),
    );
  }
  await env.DB.batch(stmts);
}

/** Acknowledge every notification for this job addressed to the operator. */
export async function acknowledgeJobNotifications(env: Env, jobId: string, actorId: string): Promise<number> {
  const cfg = config(env);
  if (cfg.operatorEmails.length === 0) return 0;
  const placeholders = cfg.operatorEmails.map(() => "?").join(", ");
  const res = await env.DB.prepare(
    `UPDATE notifications SET acknowledged_at = ?, acknowledged_by = ?
      WHERE job_id = ? AND requires_ack = 1 AND acknowledged_at IS NULL AND recipient_email IN (${placeholders})`,
  )
    .bind(Date.now(), actorId, jobId, ...cfg.operatorEmails)
    .run();
  return res.meta.changes ?? 0;
}
