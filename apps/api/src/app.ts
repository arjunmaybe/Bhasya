import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getAuthForDb, getIdentityForRequest } from '@bhasya/db';
import { logEvent } from '@bhasya/db';
import { HttpError, authorize } from '../../../authorization/resource-resolvers.js';
import { explainSelection, getServices, ingestSource, reingestSource, resolveAnchor } from './services.js';
import { CreateHighlightSchema, CreateThreadSchema, ExplainSchema, IngestSchema, PostMessageSchema, ResolveAnchorSchema } from './schema.js';
import { withTransaction } from '../../../db/transactions.js';

export function createApp(): Hono {
  const app = new Hono();
  // Identity is server-derived from the Better Auth session (production) or
  // the single seeded dev identity (local dev only). Query parameters and
  // arbitrary request headers never select the user — getIdentityForRequest
  // resolves via auth.api.getSession({ headers }) only. `x-dev-user`
  // and `?user=` selectors were removed and remain unsupported here.
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }));

  app.get('/healthz', (c) => c.json({ ok: true, service: 'bhasya-api', phase: 1 }));

  // ── Better Auth lifecycle (minimum validation routes) ──
  // Better Auth owns sign-up / sign-in / session / sign-out. Mounted on the
  // same Hono app so cookies/origins match the API boundary. Authorization
  // (workspace/resource) stays in `authorize()` + resolvers below.
  app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
    const svc = await getServices();
    const auth = await getAuthForDb(svc.db, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
    return auth.handler(c.req.raw);
  });

  const err = (c: any, e: unknown) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as any);
    const msg = e instanceof Error ? e.message : 'internal error';
    const status =
      /unauthenticated/i.test(msg) ? 401
      : /not found|no access|forbidden|private destination|malformed|unsupported|too many|too large|empty response|fetch failed/i.test(msg) ? 400
      : 500;
    return c.json({ error: msg }, status as any);
  };

  // ── Ingest ──
  app.post('/api/sources/ingest', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const parsed = IngestSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
      const out = await ingestSource(svc, identity, parsed.data.url);
      return c.json(out, 201);
    } catch (e) { return err(c, e); }
  });

  app.post('/api/sources/:id/reingest', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const out = await reingestSource(svc, identity, c.req.param('id'));
      return c.json(out, 201);
    } catch (e) { return err(c, e); }
  });

  app.get('/api/sources', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const r = await svc.db.query(
        `SELECT s.id, s.url, s.title, s.created_at,
                (SELECT v.id FROM document_versions v WHERE v.source_id = s.id ORDER BY v.version_no DESC LIMIT 1) AS latest_version_id
           FROM sources s WHERE s.workspace_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
        [identity.workspaceId],
      );
      return c.json({ sources: r.rows });
    } catch (e) { return err(c, e); }
  });

  // ── Document / tree / passages ──
  app.get('/api/documents/:versionId', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const versionId = c.req.param('versionId');
      await authorize(svc.db, identity, 'document_version', versionId);
      const v = (await svc.db.query(
        `SELECT v.*, s.url AS source_url FROM document_versions v JOIN sources s ON s.id = v.source_id WHERE v.id = $1`, [versionId],
      )).rows[0];
      if (!v) return c.json({ error: 'not found' }, 404);
      await logEvent(svc.db, { workspaceId: identity.workspaceId, userId: identity.userId, eventType: 'document_opened', resourceType: 'document_version', resourceId: versionId });
      return c.json({ version: v });
    } catch (e) { return err(c, e); }
  });

  app.get('/api/documents/:versionId/tree', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const versionId = c.req.param('versionId');
      await authorize(svc.db, identity, 'document_version', versionId);
      const nodes = (await svc.db.query(
        `SELECT id, parent_id, node_type, ordinal, depth, structural_path, text FROM document_nodes WHERE document_version_id = $1 ORDER BY structural_path`, [versionId],
      )).rows;
      const passages = (await svc.db.query(
        `SELECT id, node_id, ordinal, structural_path, text FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal`, [versionId],
      )).rows;
      return c.json({ nodes, passages });
    } catch (e) { return err(c, e); }
  });

  app.get('/api/documents/:versionId/passages', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const versionId = c.req.param('versionId');
      await authorize(svc.db, identity, 'document_version', versionId);
      const r = await svc.db.query(
        `SELECT id, node_id, ordinal, structural_path, text FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal LIMIT 500`, [versionId],
      );
      return c.json({ passages: r.rows });
    } catch (e) { return err(c, e); }
  });

  app.get('/api/documents/:versionId/highlights', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const versionId = c.req.param('versionId');
      await authorize(svc.db, identity, 'document_version', versionId);
      const r = await svc.db.query(
        `SELECT h.id AS highlight_id, a.id AS anchor_id, a.selected_text, a.start_offset, a.end_offset,
                a.structural_path, a.passage_id, a.locator, h.created_at,
                (SELECT t.id FROM threads t WHERE t.anchor_id = a.id AND t.scope_type='passage' LIMIT 1) AS thread_id
           FROM highlights h JOIN anchors a ON a.id = h.anchor_id
          WHERE a.document_version_id = $1 AND h.workspace_id = $2 ORDER BY h.created_at`,
        [versionId, identity.workspaceId],
      );
      return c.json({ highlights: r.rows });
    } catch (e) { return err(c, e); }
  });

  // ── Anchor / highlight ──
  app.post('/api/anchors/resolve', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const parsed = ResolveAnchorSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
      const out = await resolveAnchor(svc, identity, parsed.data);
      return c.json(out, 201);
    } catch (e) { return err(c, e); }
  });

  app.post('/api/highlights', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const parsed = CreateHighlightSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
      const resolved = await authorize(svc.db, identity, 'anchor', parsed.data.anchorId);
      const row = (await svc.db.query(
        `INSERT INTO highlights (anchor_id, workspace_id, color, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (anchor_id) DO UPDATE SET color = EXCLUDED.color RETURNING id`,
        [parsed.data.anchorId, resolved.workspaceId, parsed.data.color ?? 'yellow', identity.userId],
      )).rows[0] as any;
      await logEvent(svc.db, { workspaceId: resolved.workspaceId, userId: identity.userId, eventType: 'passage_highlighted', resourceType: 'highlight', resourceId: String(row.id) });
      return c.json({ highlightId: String(row.id) }, 201);
    } catch (e) { return err(c, e); }
  });

  // ── Threads ──
  app.post('/api/threads', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const parsed = CreateThreadSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
      const resolved = await authorize(svc.db, identity, 'anchor', parsed.data.anchorId);
      const created = await withTransaction(svc.db, async (tx) => {
        const t = (await tx.query(
          `INSERT INTO threads (workspace_id, source_id, anchor_id, scope_type, title, created_by)
           VALUES ($1,(SELECT v.source_id FROM anchors a JOIN document_versions v ON v.id = a.document_version_id WHERE a.id = $2),$2,'passage',$3,$4) RETURNING id`,
          [resolved.workspaceId, parsed.data.anchorId, parsed.data.title ?? 'Passage thread', identity.userId],
        )).rows[0] as any;
        return { id: String(t.id) };
      });
      const threadId = created.id;
      await logEvent(svc.db, { workspaceId: resolved.workspaceId, userId: identity.userId, eventType: 'thread_created', resourceType: 'thread', resourceId: threadId });
      return c.json({ threadId }, 201);
    } catch (e) { return err(c, e); }
  });

  app.post('/api/threads/explain', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const parsed = ExplainSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
      const out = await explainSelection(svc, identity, parsed.data);
      return c.json(out, 201);
    } catch (e) { return err(c, e); }
  });

  app.post('/api/threads/:id/messages', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const parsed = PostMessageSchema.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: 'invalid request' }, 400);
      const threadId = c.req.param('id');
      const resolved = await authorize(svc.db, identity, 'thread', threadId);
      const trow = (await svc.db.query(`SELECT anchor_id FROM threads WHERE id = $1`, [threadId])).rows[0] as any;
      if (!trow?.anchor_id) return c.json({ error: 'thread has no anchor' }, 400);
      const out = await explainSelection(svc, identity, { anchorId: String(trow.anchor_id), question: parsed.data.content, threadId });
      void resolved;
      return c.json(out, 201);
    } catch (e) { return err(c, e); }
  });

  app.get('/api/threads/by-anchor/:anchorId', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const resolved = await authorize(svc.db, identity, 'anchor', c.req.param('anchorId'));
      const r = await svc.db.query(
        `SELECT t.* FROM threads t WHERE t.anchor_id = $1 AND t.workspace_id = $2 ORDER BY t.created_at`,
        [c.req.param('anchorId'), resolved.workspaceId],
      );
      return c.json({ threads: r.rows });
    } catch (e) { return err(c, e); }
  });

  app.get('/api/threads/:id', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const threadId = c.req.param('id');
      await authorize(svc.db, identity, 'thread', threadId);
      const t = (await svc.db.query(`SELECT * FROM threads WHERE id = $1`, [threadId])).rows[0];
      const messages = (await svc.db.query(`SELECT * FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`, [threadId])).rows;
      const evidence = (await svc.db.query(
        `SELECT e.*, p.text AS passage_text, p.structural_path FROM evidence e JOIN passages p ON p.id = e.passage_id
          WHERE e.thread_message_id = ANY(SELECT id FROM thread_messages WHERE thread_id = $1) ORDER BY e.rank`, [threadId],
      )).rows;
      const citations = (await svc.db.query(
        `SELECT ci.* FROM citations ci JOIN evidence e ON e.id = ci.evidence_id
          WHERE e.thread_message_id = ANY(SELECT id FROM thread_messages WHERE thread_id = $1)`, [threadId],
      )).rows;
      await logEvent(svc.db, { workspaceId: identity.workspaceId, userId: identity.userId, eventType: 'thread_reopened', resourceType: 'thread', resourceId: threadId });
      return c.json({ thread: t, messages, evidence, citations });
    } catch (e) { return err(c, e); }
  });

  // ── Citations ──
  app.get('/api/citations/:id', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const resolved = await authorize(svc.db, identity, 'citation', c.req.param('id'));
      const row = (await svc.db.query(
        `SELECT ci.id, ci.label, ci.locator, ci.anchor_id,
                e.passage_id, e.document_version_id, e.scope_level, e.quote,
                p.text AS passage_text, p.structural_path, p.node_id
           FROM citations ci JOIN evidence e ON e.id = ci.evidence_id JOIN passages p ON p.id = e.passage_id
          WHERE ci.id = $1`, [c.req.param('id')],
      )).rows[0];
      if (!row) return c.json({ error: 'not found' }, 404);
      // Phase 2 validation: `citation_viewed` is an allowed event_log type but
      // was never emitted — only `citation_clicked` was. Logging the view
      // completes the funnel (explanation → evidence/citation viewed) using the
      // existing logEvent primitive. Logged only after authorize + existence,
      // so failures stay 401/404 with no attribution.
      await logEvent(svc.db, { workspaceId: resolved.workspaceId, userId: identity.userId, eventType: 'citation_viewed', resourceType: 'citation', resourceId: c.req.param('id') });
      return c.json({ citation: row });
    } catch (e) { return err(c, e); }
  });

  app.post('/api/citations/:id/clicked', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const resolved = await authorize(svc.db, identity, 'citation', c.req.param('id'));
      await logEvent(svc.db, { workspaceId: resolved.workspaceId, userId: identity.userId, eventType: 'citation_clicked', resourceType: 'citation', resourceId: c.req.param('id') });
      return c.json({ ok: true });
    } catch (e) { return err(c, e); }
  });

  app.post('/api/reading-sessions/start', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const body = await c.req.json().catch(() => ({})) as { documentVersionId?: string };
      if (body.documentVersionId) await authorize(svc.db, identity, 'document_version', body.documentVersionId);
      await logEvent(svc.db, { workspaceId: identity.workspaceId, userId: identity.userId, eventType: 'reading_session_started', resourceType: 'document_version', resourceId: body.documentVersionId ?? '' });
      return c.json({ ok: true });
    } catch (e) { return err(c, e); }
  });

  app.post('/api/reading-sessions/end', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const body = await c.req.json().catch(() => ({})) as { documentVersionId?: string };
      await logEvent(svc.db, { workspaceId: identity.workspaceId, userId: identity.userId, eventType: 'reading_session_ended', resourceType: 'document_version', resourceId: body.documentVersionId ?? '' });
      return c.json({ ok: true });
    } catch (e) { return err(c, e); }
  });

  app.post('/api/documents/:versionId/completed', async (c) => {
    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      const resolved = await authorize(svc.db, identity, 'document_version', c.req.param('versionId'));
      await logEvent(svc.db, { workspaceId: resolved.workspaceId, userId: identity.userId, eventType: 'document_completed', resourceType: 'document_version', resourceId: c.req.param('versionId') });
      return c.json({ ok: true });
    } catch (e) { return err(c, e); }
  });

  app.get('/api/events', async (c) => {    try {
      const svc = await getServices();
      const identity = await getIdentityForRequest(svc.db, c.req.raw.headers, { env: ((c as unknown as { env?: Record<string, unknown> }).env ?? {}) });
      if (!identity) return c.json({ error: 'unauthenticated' }, 401);
      // Phase 2 validation: include the internal user_id so per-user funnel /
      // return-usage questions are answerable through the API (workspace-scoped,
      // auth-gated; internal UUID only, no personal data). Previously omitted,
      // forcing direct DB access for attribution.
      const r = await svc.db.query(
        `SELECT event_type, resource_type, resource_id, metadata, created_at, user_id FROM event_log
          WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`, [identity.workspaceId],
      );
      return c.json({ events: r.rows });
    } catch (e) { return err(c, e); }
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
