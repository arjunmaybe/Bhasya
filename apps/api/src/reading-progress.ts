/**
 * Per-user reader progress — service.
 *
 * One resume point per (document version, authenticated user): a stable
 * passage id plus the reading line's relative position inside that passage.
 * Every query is scoped by `identity.userId`, which is derived from the
 * authenticated session (never from request input), and by the authorized
 * document version — so two users who share a workspace can never read or
 * overwrite each other's progress.
 *
 * Ordering guard. A reader instance dispatches saves that may complete out of
 * order (a normal request is still in flight when a keepalive save leaves
 * during pagehide). Each write carries the instance's opaque UUID and a
 * strictly increasing sequence. The upsert applies a write only when it comes
 * from a different instance (multi-tab last-write-wins by arrival, as agreed)
 * or when it is newer than the stored one. An older request from the SAME
 * instance can therefore never overwrite a newer position.
 *
 * `authorize()` only proves workspace membership, so it is never sufficient
 * on its own here. Writes additionally require the passage to belong to the
 * requested version.
 */
import { HttpError, authorize } from '../../../authorization/resource-resolvers.js';
import type { Identity, Services } from './services.js';

export interface ReadingProgress {
  passageId: string;
  offsetRatio: number;
  updatedAt: string;
}

export interface ReadingProgressInput {
  passageId: string;
  offsetRatio: number;
  /** Opaque per-mount reader instance (tab) id. Never a user/workspace selector. */
  instanceId: string;
  /** Strictly increasing per-instance dispatch counter. */
  sequence: number;
}

const PROGRESS_COLUMNS = `passage_id, offset_ratio, updated_at`;

function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function toProgress(row: Record<string, unknown> | undefined): ReadingProgress | null {
  if (!row) return null;
  const passageId = row['passage_id'];
  if (typeof passageId !== 'string') return null;
  const ratio = Number(row['offset_ratio']);
  return {
    passageId,
    offsetRatio: Number.isFinite(ratio) ? ratio : 0,
    updatedAt: isoTime(row['updated_at']),
  };
}

/**
 * Stored progress for this user + version. The join keeps a stale resume point
 * honest: a row is only returned when its passage is still part of the
 * requested version.
 */
async function selectStoredProgress(
  svc: Services,
  userId: string,
  versionId: string,
): Promise<ReadingProgress | null> {
  const row = (await svc.db.query(
    `SELECT rp.passage_id, rp.offset_ratio, rp.updated_at
       FROM reading_progress rp
       JOIN passages p ON p.id = rp.passage_id
                      AND p.document_version_id = rp.document_version_id
      WHERE rp.document_version_id = $1 AND rp.user_id = $2`,
    [versionId, userId],
  )).rows[0];
  return toProgress(row);
}

export async function getReadingProgress(
  svc: Services,
  identity: Identity,
  versionId: string,
): Promise<ReadingProgress | null> {
  // 404 for foreign workspaces (enumeration-safe, same as every other route).
  await authorize(svc.db, identity, 'document_version', versionId);
  return selectStoredProgress(svc, identity.userId, versionId);
}

export async function saveReadingProgress(
  svc: Services,
  identity: Identity,
  versionId: string,
  input: ReadingProgressInput,
): Promise<ReadingProgress> {
  await authorize(svc.db, identity, 'document_version', versionId);

  // A passage from another document version is treated as not found: no
  // cross-version write and no existence leak.
  const owned = (await svc.db.query(
    `SELECT 1 FROM passages WHERE id = $1 AND document_version_id = $2`,
    [input.passageId, versionId],
  )).rows[0];
  if (!owned) throw new HttpError(404, 'not found');

  const written = (await svc.db.query(
    `INSERT INTO reading_progress
       (document_version_id, user_id, passage_id, offset_ratio,
        writer_instance_id, writer_sequence, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (document_version_id, user_id) DO UPDATE
       SET passage_id = EXCLUDED.passage_id,
           offset_ratio = EXCLUDED.offset_ratio,
           writer_instance_id = EXCLUDED.writer_instance_id,
           writer_sequence = EXCLUDED.writer_sequence,
           updated_at = now()
       WHERE reading_progress.writer_instance_id <> EXCLUDED.writer_instance_id
          OR reading_progress.writer_sequence < EXCLUDED.writer_sequence
     RETURNING ${PROGRESS_COLUMNS}`,
    [
      versionId,
      identity.userId,
      input.passageId,
      input.offsetRatio,
      input.instanceId,
      input.sequence,
    ],
  )).rows[0];

  if (written) {
    const saved = toProgress(written);
    if (!saved) throw new HttpError(500, 'progress write failed');
    return saved;
  }

  // The guard rejected a late write from an older request of the same reader
  // instance. The stored position is authoritative: return it rather than
  // reporting a failure (the client ignores the response body).
  const current = await selectStoredProgress(svc, identity.userId, versionId);
  if (!current) throw new HttpError(500, 'progress write failed');
  return current;
}
