import { buildAnchor, findPassageForSelection, normalizeHtmlToCanonical, secureFetchUrl } from '@bhasya/core';
import {
  logEvent, migrate, openDb, seedDev,
  LocalStorageAdapter, MemoryStorageAdapter, R2StorageAdapter, SupabaseStorageAdapter,
  isProductionAuth, type DbClient, type StoragePort, type R2BucketLike,
} from '@bhasya/db';
import { ModelRouter, estimateExplainInputSize, retrieveExplainContext } from '@bhasya/ai';
import type { StreamTelemetry } from '@bhasya/ai';
import { withTransaction } from '../../../db/transactions.js';
import { authorize } from '../../../authorization/resource-resolvers.js';

export type Identity = { userId: string; workspaceId: string; email: string };

export interface Services {
  db: DbClient;
  storage: StoragePort;
  router: ModelRouter;
  fetchFn: typeof fetch;
}

export interface ServicesOptions {
  env?: Record<string, unknown>;
  db?: DbClient;
  storage?: StoragePort;
}

let cached: Services | null = null;

/**
 * Workerd-safe global fetch reference. Storing bare `fetch` and calling it
 * detached (`fetchFn(url, opts)`) throws "Illegal invocation" inside
 * Cloudflare Workers (Node tolerates it, which is why tests never caught it).
 * This wrapper keeps a direct `fetch(...)` call expression in both runtimes.
 */
const boundFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input as RequestInfo, init);

function newId(): string {
  // Web Crypto (Node 20+ and Cloudflare Workers). No `node:crypto` import so
  // the Worker bundle stays importable.
  return globalThis.crypto.randomUUID();
}

function readEnvValue(key: string, env?: Record<string, unknown>): string | undefined {
  const v = env?.[key];
  if (typeof v === 'string' && v.length > 0) return v;
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const pv = proc?.env?.[key];
    if (typeof pv === 'string' && pv.length > 0) return pv;
  } catch { /* Workers have no process */ }
  return undefined;
}

function pickR2Binding(env?: Record<string, unknown>): R2BucketLike | null {
  if (!env) return null;
  const candidates = ['BHASYA_BUCKET', 'BHASYA_R2', 'R2', 'BUCKET'];
  for (const k of candidates) {
    const v = env[k] as R2BucketLike | undefined;
    if (v && typeof (v as R2BucketLike).put === 'function' && typeof (v as R2BucketLike).get === 'function') {
      return v;
    }
  }
  return null;
}

/**
 * Hyperdrive binding (wrangler `[[hyperdrive]]`) exposes the Postgres
 * connection string for standard drivers (`pg` Pool + `nodejs_compat`).
 * Accepts the binding object or a plain connection string (tests/smoke).
 */
function hyperdriveConnectionString(env?: Record<string, unknown>): string | undefined {
  const h = env?.['HYPERDRIVE'] as unknown;
  if (typeof h === 'string' && h.length > 0) return h;
  if (h && typeof (h as { connectionString?: unknown }).connectionString === 'string') {
    const s = (h as { connectionString: string }).connectionString;
    if (s.length > 0) return s;
  }
  return undefined;
}

/**
 * $0 staging storage: Supabase Storage behind the same StoragePort.
 * Bucket stays private (`bhasya-artifacts` default); the server-side
 * `service_role` key travels only in Worker secrets / server env, never to
 * the browser. The application only sees `StoragePort.put/get`.
 */
export const SUPABASE_DEFAULT_BUCKET = 'bhasya-artifacts';

export function supabaseConfigFromEnv(env?: Record<string, unknown>): { url: string; serviceKey: string; bucket: string } | null {
  const url = readEnvValue('SUPABASE_URL', env);
  const serviceKey = readEnvValue('SUPABASE_SERVICE_KEY', env);
  const bucketRaw = readEnvValue('SUPABASE_STORAGE_BUCKET', env);
  if (!url && !serviceKey && !bucketRaw) return null;
  if (!url || !serviceKey) {
    throw new Error(
      'Supabase Storage is partially configured (need both SUPABASE_URL and SUPABASE_SERVICE_KEY). ' +
      'Unset both for local filesystem storage, or set both for $0 staging.',
    );
  }
  const bucket = bucketRaw && bucketRaw.length > 0 ? bucketRaw : SUPABASE_DEFAULT_BUCKET;
  return { url, serviceKey, bucket };
}

/**
 * Locked service wiring (Cloudflare Worker → same Hono router → PG/pgvector).
 *
 * Storage selection (application sees only `StoragePort`):
 * - R2 bucket binding present → R2StorageAdapter (optional future production).
 * - Else Supabase env (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`,
 *   bucket `SUPABASE_STORAGE_BUCKET` default `bhasya-artifacts`)
 *   → SupabaseStorageAdapter ($0 baseline staging, private bucket, Worker-safe fetch).
 * - Else production (`BHASYA_USE_AUTH=1`) → throw (fail closed, never fs).
 *   Fails closed only when neither configured backend is available.
 * - Else local dev → LocalStorageAdapter (filesystem, Node only).
 *
 * - Production (`BHASYA_USE_AUTH=1`): requires `DATABASE_URL` (PostgreSQL)
 *   and either an R2 bucket binding or Supabase staging env; does NOT seed
 *   the dev user.
 * - Local dev: PGlite/Postgres + migrate + single seeded dev user.
 *
 * Pass `opts.env` from the Worker bindings in production; `opts.db` /
 * `opts.storage` are injection points for tests and Worker verification
 * (in-memory fakes implementing the same contracts).
 */
export async function getServices(opts: ServicesOptions = {}): Promise<Services> {
  if (cached) return cached;
  const env = opts.env;
  const prod = isProductionAuth(env) || readEnvValue('BHASYA_USE_AUTH', env) === '1';

  // Fail closed in production: never silently fall back to the PGlite dev
  // adapter when the Worker itself must open the database. (Injected `opts.db`
  // is a test/verification seam and bypasses this check.)
  // Hyperdrive transport (locked): the HYPERDRIVE binding wins when present —
  // its DbClient is request-scoped (per-checkout pg.Client, nothing retained
  // across Worker invocations). DATABASE_URL stays the fallback for local dev
  // and any environment without the binding. Production fail-closed below unchanged.
  const hyperdriveStr = hyperdriveConnectionString(env);
  const databaseUrl = hyperdriveStr ?? readEnvValue('DATABASE_URL', env);
  if (!opts.db && prod && !databaseUrl) {
    throw new Error(
      'DATABASE_URL (PostgreSQL/pgvector, Hyperdrive recommended) required in production. ' +
      'Bind Hyperdrive (HYPERDRIVE) or set the DATABASE_URL secret; PGlite is local-dev only.',
    );
  }

  const db = opts.db ?? await openDb({ env, databaseUrl, hyperdrive: !!hyperdriveStr });
  await migrate(db);
  if (!prod) {
    await seedDev(db);
  }

  let storage: StoragePort | null = opts.storage ?? null;
  if (!storage) {
    const r2 = pickR2Binding(env);
    if (r2) {
      storage = new R2StorageAdapter(r2);
    } else {
      const supabase = supabaseConfigFromEnv(env);
      if (supabase) {
        storage = new SupabaseStorageAdapter(supabase);
      } else if (prod) {
        throw new Error(
          'R2 bucket binding required in production (StoragePort). ' +
          'Bind an R2 bucket (e.g. BHASYA_BUCKET) or set SUPABASE_URL + ' +
          'SUPABASE_SERVICE_KEY ($0 staging, private bucket bhasya-artifacts); ' +
          'LocalStorageAdapter has no filesystem inside Workers.',
        );
      } else {
        storage = new LocalStorageAdapter();
      }
    }
  }

  const mergedEnv: Record<string, unknown> = {};
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string> } }).process;
    if (proc?.env) Object.assign(mergedEnv, proc.env);
  } catch { /* ignore */ }
  if (env) Object.assign(mergedEnv, env);

  cached = { db, storage, router: ModelRouter.fromEnv(mergedEnv), fetchFn: boundFetch };
  return cached;
}

export function setServices(s: Services | null): void { cached = s; }

/** Test/Worker-verification helper: in-memory services with the same contracts. */
export async function createMemoryServices(db: DbClient): Promise<Services> {
  await migrate(db);
  return { db, storage: new MemoryStorageAdapter(), router: ModelRouter.fromEnv({}), fetchFn: boundFetch };
}

/** POST ingest source — secure intake → canonical version → tree → passages. */
export async function ingestSource(
  svc: Services, identity: Identity, rawUrl: string,
  deps: { dnsResolve?: (h: string) => Promise<string[]> } = {},
): Promise<{ sourceId: string; versionId: string; versionNo: number; passageCount: number; title: string; reused: boolean }> {
  const { finalUrl, html } = await secureFetchUrl(rawUrl, { fetchFn: svc.fetchFn, dnsResolve: deps.dnsResolve });
  const canon = normalizeHtmlToCanonical(html, finalUrl);

  // Idempotency: same workspace + same content hash → reuse existing version.
  const existing = await svc.db.query(
    `SELECT v.id AS vid, v.version_no AS vno, s.id AS sid, s.title AS title
       FROM document_versions v JOIN sources s ON s.id = v.source_id
      WHERE s.workspace_id = $1 AND v.content_hash = $2 LIMIT 1`,
    [identity.workspaceId, canon.contentHash],
  );
  if (existing.rows[0]) {
    const r = existing.rows[0] as any;
    return { sourceId: String(r.sid), versionId: String(r.vid), versionNo: Number(r.vno), passageCount: 0, title: String(r.title), reused: true };
  }

  const storageKey = `sources/${newId()}.html`;
  // Object bytes BEFORE the transaction (not transactional state).
  await svc.storage.put(storageKey, html, 'text/html');

  // Transaction owns DB state only — no network/model work inside.
  const out = await withTransaction(svc.db, async (tx) => {
    const srow = (await tx.query(
      `INSERT INTO sources (workspace_id, kind, url, title, created_by) VALUES ($1,'url',$2,$3,$4) RETURNING id`,
      [identity.workspaceId, finalUrl, canon.title, identity.userId],
    )).rows[0] as any;
    const sourceId = String(srow.id);
    const vrow = (await tx.query(
      `INSERT INTO document_versions (source_id, version_no, content_hash, title, fetched_url, content_type, lang, node_count, passage_count, storage_key)
       VALUES ($1,1,$2,$3,$4,'text/html',$5,$6,$7,$8) RETURNING id`,
      [sourceId, canon.contentHash, canon.title, finalUrl, canon.lang, canon.nodes.length, canon.passages.length, storageKey],
    )).rows[0] as any;
    const versionId = String(vrow.id);
    const nodeIdMap = new Map<string, string>();
    for (const n of canon.nodes) {
      const dbId = newId();
      nodeIdMap.set(n.id, dbId);
      await tx.query(
        `INSERT INTO document_nodes (id, document_version_id, parent_id, node_type, ordinal, depth, structural_path, text, attrs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [dbId, versionId, n.parentId ? (nodeIdMap.get(n.parentId) ?? null) : null, n.nodeType, n.ordinal, n.depth, n.structuralPath, n.text, JSON.stringify(n.attrs ?? {})],
      );
    }
    for (const p of canon.passages) {
      await tx.query(
        `INSERT INTO passages (document_version_id, node_id, ordinal, structural_path, text, text_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [versionId, nodeIdMap.get(p.nodeId), p.ordinal, p.structuralPath, p.text, p.textHash],
      );
    }
    return { sourceId, versionId };
  });

  await logEvent(svc.db, {
    workspaceId: identity.workspaceId, userId: identity.userId, eventType: 'source_imported',
    resourceType: 'document_version', resourceId: out.versionId, metadata: { url: finalUrl, title: canon.title },
  });
  return { ...out, versionNo: 1, passageCount: canon.passages.length, title: canon.title, reused: false };
}

/** Re-ingest an existing source URL → new immutable version (never mutates v1). */
export async function reingestSource(
  svc: Services, identity: Identity, sourceId: string,
  deps: { dnsResolve?: (h: string) => Promise<string[]> } = {},
): Promise<{ versionId: string; versionNo: number }> {
  await authorize(svc.db, identity, 'source', sourceId);
  const srow = (await svc.db.query(`SELECT url, title, workspace_id FROM sources WHERE id = $1`, [sourceId])).rows[0] as any;
  if (!srow?.url) throw new Error('source has no URL');
  const { finalUrl, html } = await secureFetchUrl(String(srow.url), { fetchFn: svc.fetchFn, dnsResolve: deps.dnsResolve });
  const canon = normalizeHtmlToCanonical(html, finalUrl);
  const maxRow = (await svc.db.query(`SELECT COALESCE(MAX(version_no),0) AS m FROM document_versions WHERE source_id = $1`, [sourceId])).rows[0] as any;
  const dupe = (await svc.db.query(`SELECT id FROM document_versions WHERE source_id = $1 AND content_hash = $2`, [sourceId, canon.contentHash])).rows[0] as any;
  if (dupe) return { versionId: String(dupe.id), versionNo: Number(maxRow.m) };
  const versionNo = Number(maxRow.m) + 1;
  const storageKey = `sources/${newId()}.html`;
  await svc.storage.put(storageKey, html, 'text/html');
  const out = await withTransaction(svc.db, async (tx) => {
    const vrow = (await tx.query(
      `INSERT INTO document_versions (source_id, version_no, content_hash, title, fetched_url, content_type, lang, node_count, passage_count, storage_key)
       VALUES ($1,$2,$3,$4,$5,'text/html',$6,$7,$8,$9) RETURNING id`,
      [sourceId, versionNo, canon.contentHash, canon.title, finalUrl, canon.lang, canon.nodes.length, canon.passages.length, storageKey],
    )).rows[0] as any;
    const versionId = String(vrow.id);
    const map = new Map<string, string>();
    for (const n of canon.nodes) {
      const dbId = newId();
      map.set(n.id, dbId);
      await tx.query(
        `INSERT INTO document_nodes (id, document_version_id, parent_id, node_type, ordinal, depth, structural_path, text, attrs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [dbId, versionId, n.parentId ? (map.get(n.parentId) ?? null) : null, n.nodeType, n.ordinal, n.depth, n.structuralPath, n.text, JSON.stringify(n.attrs ?? {})],
      );
    }
    for (const p of canon.passages) {
      await tx.query(
        `INSERT INTO passages (document_version_id, node_id, ordinal, structural_path, text, text_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
        [versionId, map.get(p.nodeId), p.ordinal, p.structuralPath, p.text, p.textHash],
      );
    }
    return { versionId };
  });
  await logEvent(svc.db, { workspaceId: identity.workspaceId, userId: identity.userId, eventType: 'source_imported', resourceType: 'document_version', resourceId: out.versionId, metadata: { reingest: true, versionNo } });
  return { ...out, versionNo };
}

/** Resolve a selection to the correct passage and persist the anchor. */
export async function resolveAnchor(
  svc: Services, identity: Identity,
  args: { documentVersionId: string; selectedText: string; passageId?: string; cssHint?: string },
): Promise<{ anchorId: string; passageId: string; nodeId: string; startOffset: number; endOffset: number }> {
  await authorize(svc.db, identity, 'document_version', args.documentVersionId);
  const sel = args.selectedText.trim();
  if (!sel) throw new Error('empty selection');
  let passages: Array<{ id: string; nodeId: string; structuralPath: string; text: string }>;
  if (args.passageId) {
    await authorize(svc.db, identity, 'passage', args.passageId);
    const r = await svc.db.query(
      `SELECT id, node_id, structural_path, text FROM passages WHERE id = $1 AND document_version_id = $2`,
      [args.passageId, args.documentVersionId],
    );
    if (!r.rows[0]) throw new Error('passage not in document version');
    const row = r.rows[0] as any;
    passages = [{ id: String(row.id), nodeId: String(row.node_id), structuralPath: String(row.structural_path), text: String(row.text) }];
  } else {
    const r = await svc.db.query(
      `SELECT id, node_id, structural_path, text FROM passages WHERE document_version_id = $1`,
      [args.documentVersionId],
    );
    passages = r.rows.map((row: any) => ({ id: String(row.id), nodeId: String(row.node_id), structuralPath: String(row.structural_path), text: String(row.text) }));
  }
  const found = findPassageForSelection(passages, sel);
  if (!found) throw new Error('selection not found in document version');
  const anchor = buildAnchor({
    documentVersionId: args.documentVersionId,
    passage: { id: found.passage.id, nodeId: found.passage.nodeId, structuralPath: found.passage.structuralPath, text: found.passage.text },
    selectedText: sel, cssHint: args.cssHint,
  });
  const row = (await svc.db.query(
    `INSERT INTO anchors (document_version_id, node_id, passage_id, selected_text, start_offset, end_offset, text_hash, structural_path, context_fingerprint, locator, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
    [anchor.documentVersionId, anchor.nodeId, anchor.passageId, anchor.selectedText, anchor.startOffset, anchor.endOffset,
     anchor.textHash, anchor.structuralPath, anchor.contextFingerprint, JSON.stringify(anchor.locator), identity.userId],
  )).rows[0] as any;
  return { anchorId: String(row.id), passageId: found.passage.id, nodeId: found.passage.nodeId, startOffset: anchor.startOffset, endOffset: anchor.endOffset };
}

export interface ExplainResult {
  threadId: string; userMessageId: string; assistantMessageId: string;
  text: string; modelId: string; citationIds: string[];
}

export interface ExplainArgs { anchorId: string; question?: string; threadId?: string }

interface PreparedExplain {
  resolved: { workspaceId: string };
  arow: any;
  ctx: { l0: { id: string; structuralPath: string; text: string }; l1: Array<{ id: string; text: string }> };
  question: string;
  title: string;
  created: { threadId: string; userMessageId: string; isNew: boolean };
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  input: { selection: string; nearbyContext: string[]; userRequest: string; title: string; history: Array<{ role: 'user' | 'assistant'; content: string }> };
}

/**
 * Shared preparation for explain paths (TX1 + retrieval + history + input).
 * No network/model work inside: thread + user message persist first, then
 * the provider is called OUTSIDE any transaction by the caller.
 */
async function prepareExplainState(
  svc: Services, identity: Identity, args: ExplainArgs,
): Promise<PreparedExplain> {
  const resolved = await authorize(svc.db, identity, 'anchor', args.anchorId);
  const arow = (await svc.db.query(
    `SELECT a.*, s.workspace_id AS ws FROM anchors a
      JOIN document_versions v ON v.id = a.document_version_id
      JOIN sources s ON s.id = v.source_id WHERE a.id = $1`,
    [args.anchorId],
  )).rows[0] as any;
  if (!arow || String(arow.ws) !== resolved.workspaceId) throw new Error('anchor workspace mismatch');
  if (!arow.passage_id) throw new Error('anchor has no passage');

  const ctx = await retrieveExplainContext(svc.db, { documentVersionId: String(arow.document_version_id), passageId: String(arow.passage_id) });
  const question = args.question?.trim() || 'Explain this passage.';
  const titleRow = (await svc.db.query(`SELECT title FROM document_versions WHERE id = $1`, [String(arow.document_version_id)])).rows[0] as any;

  // ── TX 1: thread + user message + events (no network inside) ──
  let threadId = args.threadId ?? null;
  if (threadId) await authorize(svc.db, identity, 'thread', threadId);
  else {
    const existing = (await svc.db.query(`SELECT id FROM threads WHERE anchor_id = $1 AND scope_type = 'passage' LIMIT 1`, [args.anchorId])).rows[0] as any;
    if (existing) threadId = String(existing.id);
  }
  // Thread identity (pre-insert): an explicit threadId must belong to this
  // anchor. Without this, anchor A's passage could be answered into thread B
  // — cross-thread contamination. Checked before any insert so a mismatch
  // leaves no stray user message behind.
  if (threadId) {
    const owner = (await svc.db.query(
      `SELECT anchor_id FROM threads WHERE id = $1`, [threadId],
    )).rows[0] as any;
    if (!owner || String(owner.anchor_id) !== args.anchorId) {
      throw new Error('thread anchor mismatch');
    }
  }
  const created = await withTransaction(svc.db, async (tx) => {
    let tid = threadId;
    let isNew = false;
    if (!tid) {
      const trow = (await tx.query(
        `INSERT INTO threads (workspace_id, source_id, anchor_id, scope_type, title, created_by)
         VALUES ($1,(SELECT source_id FROM document_versions WHERE id = $2),$3,'passage',$4,$5) RETURNING id`,
        [resolved.workspaceId, String(arow.document_version_id), args.anchorId, `Passage thread`, identity.userId],
      )).rows[0] as any;
      tid = String(trow.id);
      isNew = true;
    }
    const urow = (await tx.query(
      `INSERT INTO thread_messages (thread_id, role, content, created_by) VALUES ($1,'user',$2,$3) RETURNING id`,
      [tid, question, identity.userId],
    )).rows[0] as any;
    return { threadId: tid as string, userMessageId: String(urow.id), isNew };
  });

  // Prior conversation in this thread only (oldest first, excluding the
  // just-persisted current user message). Empty for the initial explanation.
  // Scoped by thread_id so sibling threads never leak into each other.
  const histRows = (await svc.db.query(
    `SELECT role, content FROM thread_messages WHERE thread_id = $1 AND id <> $2 ORDER BY created_at ASC LIMIT 50`,
    [created.threadId, created.userMessageId],
  )).rows as any[];
  const history = histRows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: String(r.content ?? '') }))
    .filter((t) => t.content.trim().length > 0);

  // The explanation is about the user's exact persisted selection. The full
  // passage text stays available as grounding context (first L1 entry) so the
  // explanation remains grounded in its passage when the selection is a slice
  // of that passage. Fallback to the passage text only when selected_text is
  // unexpectedly empty (resolveAnchor normally rejects empty selections).
  const exactSelection = String(arow.selected_text ?? '').trim();
  const selection = exactSelection.length > 0 ? exactSelection : ctx.l0.text;
  const title = String(titleRow?.title ?? '');
  const input = {
    selection,
    nearbyContext: [ctx.l0.text, ...ctx.l1.map((p) => p.text)],
    userRequest: question,
    title,
    history,
  };
  return { resolved, arow, ctx, question, title, created, history, input };
}

/**
 * Shared TX 2: assistant message + evidence + citations + highlight.
 * Identical for streaming and non-streaming paths: persistence always covers
 * the final complete text, never partial chunks.
 */
async function persistAssistantResult(
  svc: Services, identity: Identity, prep: PreparedExplain, args: ExplainArgs,
  text: string, modelId: string,
): Promise<{ assistantMessageId: string; citationIds: string[] }> {
  const { arow, ctx, created, resolved } = prep;
  return withTransaction(svc.db, async (tx) => {
    const mrow = (await tx.query(
      `INSERT INTO thread_messages (thread_id, role, content, model_id, created_by) VALUES ($1,'assistant',$2,$3,$4) RETURNING id`,
      [created.threadId, text, modelId, identity.userId],
    )).rows[0] as any;
    const assistantId = String(mrow.id);
    const evL0 = (await tx.query(
      `INSERT INTO evidence (thread_message_id, passage_id, document_version_id, score, rank, scope_level, quote)
       VALUES ($1,$2,$3,1.0,0,'L0',$4) RETURNING id`,
      [assistantId, ctx.l0.id, String(arow.document_version_id), ctx.l0.text.slice(0, 500)],
    )).rows[0] as any;
    const citationIds: string[] = [];
    const c0 = (await tx.query(
      `INSERT INTO citations (evidence_id, anchor_id, locator, label) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
      [String(evL0.id), args.anchorId, JSON.stringify({ nodePath: ctx.l0.structuralPath, passageId: ctx.l0.id }), 'Cited passage'],
    )).rows[0] as any;
    citationIds.push(String(c0.id));
    let rank = 1;
    for (const p of ctx.l1.slice(0, 2)) {
      const ev = (await tx.query(
        `INSERT INTO evidence (thread_message_id, passage_id, document_version_id, score, rank, scope_level, quote)
         VALUES ($1,$2,$3,$4,$5,'L1',$6) RETURNING id`,
        [assistantId, p.id, String(arow.document_version_id), 0.5 / rank, rank, p.text.slice(0, 500)],
      )).rows[0] as any;
      rank += 1;
      void ev;
    }
    await tx.query(
      `INSERT INTO highlights (anchor_id, workspace_id, created_by) VALUES ($1,$2,$3) ON CONFLICT (anchor_id) DO NOTHING`,
      [args.anchorId, resolved.workspaceId, identity.userId],
    );
    await tx.query(`UPDATE threads SET updated_at = now() WHERE id = $1`, [created.threadId]);
    return { assistantMessageId: assistantId, citationIds };
  });
}

/**
 * Shared event logging for explain paths.
 * Validation metadata only: model identity + latency + input/output sizes.
 * No prompts, responses, document text, or personal data (see DATA/PRIVACY).
 */
async function logExplainEvents(
  svc: Services, identity: Identity, prep: PreparedExplain, args: ExplainArgs,
  metadata: Record<string, string | number>,
): Promise<void> {
  const { created } = prep;
  await logEvent(svc.db, {
    workspaceId: prep.resolved.workspaceId, userId: identity.userId,
    eventType: created.isNew && !args.threadId ? 'thread_created' : 'thread_message_sent',
    resourceType: 'thread', resourceId: created.threadId,
    metadata: { anchorId: args.anchorId, ...metadata },
  });
  await logEvent(svc.db, {
    workspaceId: prep.resolved.workspaceId, userId: identity.userId, eventType: 'passage_highlighted',
    resourceType: 'anchor', resourceId: args.anchorId, metadata: { threadId: created.threadId },
  });
}

/** Explain: tx(create state) → model call OUTSIDE tx → tx(persist result). */
export async function explainSelection(
  svc: Services, identity: Identity,
  args: ExplainArgs,
): Promise<ExplainResult> {
  const requestStart = Date.now();
  const prep = await prepareExplainState(svc, identity, args);
  // Phase 2 validation: time the AI call so latency is measurable from the
  // existing thread events (metadata only — never prompts/responses/content).
  const explainStartedAt = Date.now();
  const out = await svc.router.explain(prep.input);
  const explainDurationMs = Date.now() - explainStartedAt;
  const persisted = await persistAssistantResult(svc, identity, prep, args, out.text, out.modelId);
  const size = estimateExplainInputSize(prep.input);
  await logExplainEvents(svc, identity, prep, args, {
    modelId: out.modelId,
    durationMs: explainDurationMs,
    totalMs: Date.now() - requestStart,
    inputChars: size.inputChars,
    inputTokenEstimate: size.inputTokenEstimate,
    outputChars: out.text.length,
  });
  return {
    threadId: prep.created.threadId, userMessageId: prep.created.userMessageId,
    assistantMessageId: persisted.assistantMessageId, text: out.text,
    modelId: out.modelId, citationIds: persisted.citationIds,
  };
}

export type ExplainStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; result: ExplainResult; telemetry: StreamTelemetry };

/**
 * Streaming explain: TX1 (thread + user message) → provider stream OUTSIDE
 * any transaction (chunks forwarded to `sink` as they arrive) → TX2 persists
 * the final complete text with the same evidence/citations/highlight as the
 * non-streaming path. History, identity, and validation-metadata rules are
 * unchanged. A stream that yields no text throws before anything persists.
 */
export async function streamExplainSelection(
  svc: Services, identity: Identity, args: ExplainArgs,
  sink: (event: ExplainStreamEvent) => void | Promise<void>,
): Promise<ExplainResult> {
  const requestStart = Date.now();
  const prep = await prepareExplainState(svc, identity, args);
  const size = estimateExplainInputSize(prep.input);
  const providerStart = Date.now();
  let accumulated = '';
  let modelId = svc.router.adapterId;
  let provider: string | undefined;
  let completionTokens: number | undefined;
  let firstChunkAt = -1;
  for await (const item of svc.router.streamExplain(prep.input)) {
    if (item.kind === 'chunk') {
      if (item.text.length === 0) continue;
      if (firstChunkAt < 0) firstChunkAt = Date.now();
      accumulated += item.text;
      await sink({ type: 'chunk', text: item.text });
    } else {
      accumulated = item.text.length > 0 ? item.text : accumulated;
      modelId = item.modelId;
      provider = item.provider;
      completionTokens = item.completionTokens;
    }
  }
  if (accumulated.trim().length === 0) throw new Error('empty provider response');
  const providerEnd = Date.now();
  const persisted = await persistAssistantResult(svc, identity, prep, args, accumulated, modelId);
  const ttftMs = firstChunkAt >= 0 ? firstChunkAt - providerStart : providerEnd - providerStart;
  const telemetry: StreamTelemetry = {
    ttftMs,
    generationMs: Math.max(0, providerEnd - (firstChunkAt >= 0 ? firstChunkAt : providerStart)),
    totalMs: providerEnd - requestStart,
    modelId,
    ...(provider ? { provider } : {}),
    inputChars: size.inputChars,
    inputTokenEstimate: size.inputTokenEstimate,
    outputChars: accumulated.length,
    outputTokenEstimate: typeof completionTokens === 'number'
      ? completionTokens
      : Math.max(1, Math.ceil(accumulated.length / 4)),
  };
  await logExplainEvents(svc, identity, prep, args, {
    modelId: telemetry.modelId,
    durationMs: providerEnd - providerStart,
    totalMs: telemetry.totalMs,
    ttftMs: telemetry.ttftMs,
    generationMs: telemetry.generationMs,
    ...(telemetry.provider ? { provider: telemetry.provider } : {}),
    inputChars: telemetry.inputChars,
    inputTokenEstimate: telemetry.inputTokenEstimate,
    outputChars: telemetry.outputChars,
    outputTokenEstimate: telemetry.outputTokenEstimate,
  });
  const result: ExplainResult = {
    threadId: prep.created.threadId, userMessageId: prep.created.userMessageId,
    assistantMessageId: persisted.assistantMessageId, text: accumulated,
    modelId, citationIds: persisted.citationIds,
  };
  await sink({ type: 'done', result, telemetry });
  return result;
}
