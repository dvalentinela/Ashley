import { newId } from "../lib/db";

export type ActorRole = "customer" | "operator" | "partner" | "system" | "agent";

export interface EventActor {
  userId: string | null;
  role: ActorRole;
}

export interface EventInput {
  jobId: string;
  actor: EventActor;
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  jobVersion: number;
  refTable?: string | null;
  refId?: string | null;
  detail?: Record<string, unknown>;
  visibility?: "internal" | "customer";
}

export function eventInsert(db: D1Database, e: EventInput, now = Date.now()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO job_events (id, job_id, created_at, actor_id, actor_role, type, from_status, to_status,
        job_version, ref_table, ref_id, detail, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("evt"),
      e.jobId,
      now,
      e.actor.userId,
      e.actor.role,
      e.type,
      e.fromStatus ?? null,
      e.toStatus ?? null,
      e.jobVersion,
      e.refTable ?? null,
      e.refId ?? null,
      JSON.stringify(e.detail ?? {}),
      e.visibility ?? "internal",
    );
}

export function messageInsert(
  db: D1Database,
  m: {
    jobId: string;
    authorId: string | null;
    authorRole: "customer" | "operator" | "agent" | "system";
    kind: "message" | "note" | "issue" | "resolution";
    visibility: "internal" | "customer";
    body: string;
  },
  now = Date.now(),
): { id: string; stmt: D1PreparedStatement } {
  const id = newId("msg");
  return {
    id,
    stmt: db
      .prepare(
        `INSERT INTO job_messages (id, job_id, author_id, author_role, kind, visibility, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, m.jobId, m.authorId, m.authorRole, m.kind, m.visibility, m.body, now),
  };
}

export interface EventRow {
  id: string;
  created_at: number;
  actor_id: string | null;
  actor_role: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  job_version: number;
  ref_table: string | null;
  ref_id: string | null;
  detail: string;
  visibility: string;
}

export async function listEvents(db: D1Database, jobId: string, customerView: boolean): Promise<EventRow[]> {
  const sql = customerView
    ? "SELECT * FROM job_events WHERE job_id = ? AND visibility = 'customer' ORDER BY created_at, rowid"
    : "SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at, rowid";
  return (await db.prepare(sql).bind(jobId).all<EventRow>()).results;
}
