import { AppError, STALE_MESSAGE, conflict } from "./errors";

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (const b of bytes) out += alphabet[b % 32];
  return `${prefix}_${out}`;
}

/**
 * A statement that aborts the surrounding batch unless `condition` (an SQL
 * boolean expression) is true. Put it first in a batch to make a
 * read-validate-write sequence atomic.
 */
export function guard(db: D1Database, condition: string, ...params: unknown[]): D1PreparedStatement {
  return db
    .prepare(`UPDATE guard SET ok = (CASE WHEN (${condition}) THEN 1 ELSE 0 END) WHERE id = 1`)
    .bind(...params);
}

/** Guard: the job still has the version that was read. */
export function jobVersionGuard(db: D1Database, jobId: string, version: number): D1PreparedStatement {
  return guard(db, "EXISTS (SELECT 1 FROM jobs WHERE id = ? AND version = ?)", jobId, version);
}

function isPreconditionFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("precondition_failed");
}

function isUniqueFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("UNIQUE constraint failed");
}

/**
 * Runs statements as one D1 transaction. A failed guard becomes a 409 with
 * the given message; a unique-constraint failure becomes a 409 as well.
 */
export async function runBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  staleMessage = STALE_MESSAGE,
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (err) {
    if (isPreconditionFailure(err)) throw conflict(staleMessage);
    if (isUniqueFailure(err)) throw conflict("This was already recorded. Reload to see the current state.");
    throw err;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
