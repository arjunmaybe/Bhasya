import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { migrate, openDb, getIdentityForRequest, MemoryStorageAdapter, type DbClient } from '@bhasya/db';
import { DevGroundedAdapter, ModelRouter } from '@bhasya/ai';
import { createApp } from '../apps/api/src/app.js';
import { setServices, type Services } from '../apps/api/src/services.js';
import { ingestSource, resolveAnchor, explainSelection } from '../apps/api/src/services.js';
import { mockFetch, publicDns } from './helpers.js';

/**
 * Phase 2 validation instrumentation — smallest additive surface that answers
 * the validation questions with existing primitives:
 *
 * - GET /api/citations/:id emits `citation_viewed` (an allowed event_log type
 *   that was previously never written; only `citation_clicked` was).
 * - GET /api/events exposes the internal `user_id` per event (workspace-scoped,
 *   auth-gated; internal UUID only) so per-user funnel / return-usage questions
 *   are answerable through the API instead of direct DB access.
 * - thread_created / thread_message_sent metadata carries `modelId` +
 *   `durationMs` (latency signal; never prompts/responses/content).
 *
 * Boundaries verified here: correct-user attribution, no attribution on
 * unauthenticated access, no cross-workspace leak (404), retry/idempotent
 * reads create no duplicate state, failures stay 401/404, and no content or
 * personal data lands in event metadata.
 *
 * Runs on the production path (BHASYA_USE_AUTH=1). Auth, resolvers,
 * transactions, and the canonical chain are unchanged (existing suites cover
 * them; this file only covers the new instrumentation).
 */

const PREV_AUTH = process.env.BHASYA_USE_AUTH;
const PREV_SECRET = process.env.BETTER_AUTH_SECRET;
const PREV_URL = process.env.BETTER_AUTH_URL;
const TEST_SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
const PASSWORD = 'Password123!';

async function makeProdDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const db = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  return { db, cleanup: async () => { await db.close?.(); } };
}

function makeSvc(db: DbClient): Services {
  return { db, storage: new MemoryStorageAdapter(), router: new ModelRouter(new DevGroundedAdapter()), fetchFn: mockFetch() };
}

type App = ReturnType<typeof createApp>;

function sessionCookieFrom(res: Response): string {
  const getSet = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raws: string[] = typeof getSet === 'function'
    ? getSet.call(res.headers)
    : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=[^;,]*;)/);
  return raws.map((s) => s.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function signUp(app: App, email: string, name: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body, cookie: sessionCookieFrom(res) };
}

/** Alice with one ingested source, one anchor, one explained thread + citation. */
async function seedAliceFlow(db: DbClient, app: App, email = 'p2alice@bhasya.test') {
  const up = await signUp(app, email, 'P2Alice');
  expect(up.status).toBe(200);
  const identity = (await getIdentityForRequest(db, new Headers({ cookie: up.cookie })))!;
  expect(identity).not.toBeNull();
  const svc = makeSvc(db);
  const ing = await ingestSource(svc, identity, 'https://example.com/craft-of-reading', { dnsResolve: publicDns });
  const anchor = await resolveAnchor(svc, identity, {
    documentVersionId: ing.versionId, selectedText: 'Attention is the rarest and purest form of generosity',
  });
  const ex = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
  return { cookie: up.cookie, identity, ing, anchor, ex };
}

async function countEvents(db: DbClient, type: string, userId?: string): Promise<number> {
  const rows = (await db.query(
    userId
      ? `SELECT id FROM event_log WHERE event_type = $1 AND user_id = $2`
      : `SELECT id FROM event_log WHERE event_type = $1`,
    userId ? [type, userId] : [type],
  )).rows;
  return rows.length;
}

beforeEach(() => {
  process.env.BHASYA_USE_AUTH = '1';
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = 'http://localhost';
});

afterEach(() => {
  if (PREV_AUTH === undefined) delete process.env.BHASYA_USE_AUTH;
  else process.env.BHASYA_USE_AUTH = PREV_AUTH;
  if (PREV_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = PREV_SECRET;
  if (PREV_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = PREV_URL;
  setServices(null);
});

describe('phase 2 validation instrumentation', () => {
  it('citation view emits citation_viewed attributed to the correct user', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { cookie, identity, ex } = await seedAliceFlow(db, app);
      const citeId = ex.citationIds[0];

      expect(await countEvents(db, 'citation_viewed')).toBe(0);
      const res = await app.request(`/api/citations/${citeId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect((await res.json() as any)?.citation?.id).toBe(citeId);

      const rows = (await db.query(
        `SELECT user_id, workspace_id, resource_id FROM event_log WHERE event_type = 'citation_viewed'`, [],
      )).rows as any[];
      expect(rows.length).toBe(1);
      expect(String(rows[0].user_id)).toBe(identity.userId);
      expect(String(rows[0].workspace_id)).toBe(identity.workspaceId);
      expect(String(rows[0].resource_id)).toBe(citeId);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('unauthenticated citation view stays 401 and attributes nothing', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { ex, identity } = await seedAliceFlow(db, app);

      const anon = await app.request(`/api/citations/${ex.citationIds[0]}`);
      expect(anon.status).toBe(401);
      expect(await countEvents(db, 'citation_viewed')).toBe(0);

      // Even with spoof headers, nothing is attributed to anyone.
      const spoofed = await app.request(`/api/citations/${ex.citationIds[0]}`, {
        headers: { 'x-dev-user': identity.userId, 'x-user-id': identity.userId },
      });
      expect(spoofed.status).toBe(401);
      expect(await countEvents(db, 'citation_viewed')).toBe(0);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('cross-workspace citation view stays 404 with no leak or attribution', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { ex, identity } = await seedAliceFlow(db, app);
      const bob = await signUp(app, 'p2bob@bhasya.test', 'P2Bob');
      expect(bob.status).toBe(200);
      const bobId = (await getIdentityForRequest(db, new Headers({ cookie: bob.cookie })))!;
      expect(bobId.userId).not.toBe(identity.userId);

      const cross = await app.request(`/api/citations/${ex.citationIds[0]}`, { headers: { cookie: bob.cookie } });
      expect(cross.status).toBe(404);
      // No view attributed to Alice, and nothing useful leaked to Bob.
      expect(await countEvents(db, 'citation_viewed', identity.userId)).toBe(0);
      expect(await countEvents(db, 'citation_viewed', bobId.userId)).toBe(0);
      expect(await cross.json().catch(() => ({}))).not.toHaveProperty('citation');
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('/api/events exposes per-event user_id for the workspace funnel', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { cookie, identity, ex } = await seedAliceFlow(db, app);
      await app.request(`/api/citations/${ex.citationIds[0]}`, { headers: { cookie } });

      const res = await app.request('/api/events', { headers: { cookie } });
      expect(res.status).toBe(200);
      const events = ((await res.json()) as any).events as any[];
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(String(e.user_id)).toBe(identity.userId);
      const types = events.map((e) => String(e.event_type));
      for (const t of ['source_imported', 'thread_created', 'passage_highlighted', 'citation_viewed']) {
        expect(types).toContain(t);
      }

      // Unauthenticated callers get 401, not another workspace's funnel.
      expect((await app.request('/api/events')).status).toBe(401);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('retry/reopen reads create no duplicate state', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { cookie, ex } = await seedAliceFlow(db, app);
      const citeId = ex.citationIds[0];
      const counts = async () => ({
        citations: (await db.query(`SELECT id FROM citations`, [])).rows.length,
        messages: (await db.query(`SELECT id FROM thread_messages`, [])).rows.length,
        threads: (await db.query(`SELECT id FROM threads`, [])).rows.length,
      });
      const before = await counts();

      expect((await app.request(`/api/citations/${citeId}`, { headers: { cookie } })).status).toBe(200);
      expect((await app.request(`/api/citations/${citeId}`, { headers: { cookie } })).status).toBe(200);
      expect((await app.request(`/api/threads/${ex.threadId}`, { headers: { cookie } })).status).toBe(200);
      expect((await app.request(`/api/threads/${ex.threadId}`, { headers: { cookie } })).status).toBe(200);

      // Reads are idempotent on domain state (events are append-only by design;
      // the validated invariant is that threads/messages/citations do not grow).
      expect(await counts()).toEqual(before);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('explanation events carry model + latency metadata and never content', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { ex } = await seedAliceFlow(db, app);

      const rows = (await db.query(
        `SELECT event_type, metadata FROM event_log WHERE resource_id = $1 AND event_type IN ('thread_created','thread_message_sent')`,
        [ex.threadId],
      )).rows as any[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        expect(String(r.metadata?.modelId ?? '')).toBe('dev-grounded-1');
        expect(typeof r.metadata?.durationMs).toBe('number');
        expect(Number(r.metadata.durationMs)).toBeGreaterThanOrEqual(0);
        expect(String(r.metadata?.anchorId ?? '').length).toBeGreaterThan(0);
        // Privacy: no prompts, responses, document text, or identifiers.
        for (const forbidden of ['prompt', 'response', 'content', 'selection', 'text', 'email', 'ip']) {
          expect(r.metadata ?? {}).not.toHaveProperty(forbidden);
        }
      }
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('unknown ids stay 404 without attribution (failure representation)', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const { cookie, identity } = await seedAliceFlow(db, app);
      const missing = '00000000-0000-0000-0000-000000000099';

      expect((await app.request(`/api/citations/${missing}`, { headers: { cookie } })).status).toBe(404);
      expect((await app.request(`/api/threads/${missing}`, { headers: { cookie } })).status).toBe(404);
      expect((await app.request(`/api/documents/${missing}`, { headers: { cookie } })).status).toBe(404);
      expect(await countEvents(db, 'citation_viewed', identity.userId)).toBe(0);
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});
