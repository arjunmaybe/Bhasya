/**
 * Frozen resource-resolver + authorization architecture (FROZEN).
 *
 * Pipeline: authenticate → resolve authoritative resource → derive workspace
 * → membership/permission → continue.
 *
 * - Resolvers resolve existence + authoritative workspace. They do NOT authorize.
 * - Authorization (requireWorkspaceMember) is a separate layer.
 * - Combined pipeline yields enumeration-safe HTTP behavior: unauthenticated →
 *   401; authenticated but no access → 404 (not 403) so resource existence is
 *   not leaked.
 */

export type DevIdentity = { userId: string; workspaceId: string; email: string };

export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type ResolvedResource = { kind: string; id: string; workspaceId: string };

const RESOURCE_WORKSPACE_SQL: Record<string, string> = {
  source: `SELECT workspace_id FROM sources WHERE id = $1`,
  document_version: `SELECT s.workspace_id FROM document_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1`,
  passage: `SELECT s.workspace_id FROM passages p JOIN document_versions v ON v.id = p.document_version_id JOIN sources s ON s.id = v.source_id WHERE p.id = $1`,
  anchor: `SELECT s.workspace_id FROM anchors a JOIN document_versions v ON v.id = a.document_version_id JOIN sources s ON s.id = v.source_id WHERE a.id = $1`,
  highlight: `SELECT h.workspace_id FROM highlights h WHERE h.id = $1`,
  thread: `SELECT workspace_id FROM threads WHERE id = $1`,
  message: `SELECT t.workspace_id FROM thread_messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $1`,
  evidence: `SELECT t.workspace_id FROM evidence e JOIN thread_messages m ON m.id = e.thread_message_id JOIN threads t ON t.id = m.thread_id WHERE e.id = $1`,
  citation: `SELECT t.workspace_id FROM citations c JOIN evidence e ON e.id = c.evidence_id JOIN thread_messages m ON m.id = e.thread_message_id JOIN threads t ON t.id = m.thread_id WHERE c.id = $1`,
};

export async function resolveResource(
  db: Queryable, kind: keyof typeof RESOURCE_WORKSPACE_SQL | string, id: string,
): Promise<ResolvedResource | null> {
  const sql = RESOURCE_WORKSPACE_SQL[kind];
  if (!sql) return null;
  const r = await db.query(sql, [id]);
  const row = r.rows[0] as { workspace_id?: string } | undefined;
  if (!row?.workspace_id) return null;
  return { kind, id, workspaceId: row.workspace_id };
}

export async function requireWorkspaceMember(
  db: Queryable, userId: string, workspaceId: string,
): Promise<void> {
  const r = await db.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  if (r.rows.length === 0) throw new HttpError(404, 'not found');
}

/** Full pipeline for Hono handlers. Throws HttpError(401|404). */
export async function authorize(
  db: Queryable,
  identity: DevIdentity | null,
  kind: string,
  id: string,
): Promise<ResolvedResource> {
  if (!identity) throw new HttpError(401, 'unauthenticated');
  const resolved = await resolveResource(db, kind, id);
  if (!resolved) throw new HttpError(404, 'not found');
  await requireWorkspaceMember(db, identity.userId, resolved.workspaceId);
  return resolved;
}
