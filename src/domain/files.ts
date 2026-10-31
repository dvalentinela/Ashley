import type { Actor } from "../auth";
import { config, type Env } from "../env";
import { newId, sha256Hex } from "../lib/db";
import { AppError, invalid, notFound } from "../lib/errors";

export type AttachmentKind = "customer_material" | "evidence" | "receipt";

export interface AttachmentRow {
  id: string;
  job_id: string;
  kind: AttachmentKind;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_FILES = 5;

export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()]/g, "_").slice(0, 120).trim();
  return cleaned || "file";
}

export function pickFiles(value: unknown): File[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.filter((f): f is File => f instanceof File && f.size > 0);
}

/**
 * Validates and writes files to private R2 storage. Returns the D1 inserts to
 * commit with the owning change, plus a cleanup that deletes the objects if
 * that commit fails.
 */
export async function stageFiles(
  env: Env,
  jobId: string,
  kind: AttachmentKind,
  files: File[],
  uploaderId: string,
  now = Date.now(),
): Promise<{ rows: AttachmentRow[]; statements: D1PreparedStatement[]; cleanup: () => Promise<void> }> {
  const cfg = config(env);
  if (files.length > MAX_FILES) throw invalid(`Attach at most ${MAX_FILES} files at a time`);
  for (const f of files) {
    if (f.size > cfg.maxUploadBytes) {
      throw new AppError(413, `${cleanFilename(f.name)} is larger than ${Math.round(cfg.maxUploadBytes / 1048576)} MB`);
    }
    if (!ALLOWED_TYPES.has(f.type)) {
      throw new AppError(415, `${cleanFilename(f.name)}: file type ${f.type || "unknown"} is not accepted (PDF, image, text or Word)`);
    }
  }
  const rows: AttachmentRow[] = [];
  try {
    for (const f of files) {
      const id = newId("att");
      const key = `jobs/${jobId}/${id}`;
      const bytes = await f.arrayBuffer();
      const row: AttachmentRow = {
        id,
        job_id: jobId,
        kind,
        r2_key: key,
        filename: cleanFilename(f.name),
        content_type: f.type,
        size: f.size,
        sha256: await sha256Hex(bytes),
        uploaded_by: uploaderId,
        created_at: now,
      };
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: f.type }, customMetadata: { jobId, attachmentId: id } });
      rows.push(row);
    }
  } catch (err) {
    await Promise.allSettled(rows.map((r) => env.FILES.delete(r.r2_key)));
    throw err;
  }
  const statements = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO attachments (id, job_id, kind, r2_key, filename, content_type, size, sha256, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(r.id, r.job_id, r.kind, r.r2_key, r.filename, r.content_type, r.size, r.sha256, r.uploaded_by, r.created_at),
  );
  return {
    rows,
    statements,
    cleanup: async () => {
      await Promise.allSettled(rows.map((r) => env.FILES.delete(r.r2_key)));
    },
  };
}

export async function listAttachments(db: D1Database, jobId: string): Promise<AttachmentRow[]> {
  return (await db.prepare("SELECT * FROM attachments WHERE job_id = ? ORDER BY created_at, rowid").bind(jobId).all<AttachmentRow>())
    .results;
}

/**
 * Authorizes a download. Operators may read any job's files; customers only
 * files on their own jobs; partners never receive files. Unauthorized and
 * missing files both return 404 so existence is not disclosed.
 */
export async function authorizeDownload(env: Env, actor: Actor, attachmentId: string): Promise<AttachmentRow> {
  if (actor.role === "partner") throw notFound("File not found");
  const row = await env.DB.prepare(
    `SELECT a.* FROM attachments a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ? AND (? = 'operator' OR j.customer_id = ?)`,
  )
    .bind(attachmentId, actor.role, actor.userId)
    .first<AttachmentRow>();
  if (!row) throw notFound("File not found");
  return row;
}
