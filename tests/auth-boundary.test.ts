import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { migrate, openDb, getIdentityForRequest, MemoryStorageAdapter, type DbClient } from '@bhasya/db';
import { DevGroundedAdapter, ModelRouter } from '@bhasya/ai';
import { createApp } from '../apps/api/src/app.js';
import { setServices, type Services } from '../apps/api/src/services.js';
import { ingestSample, mockFetch, publicDns } from './helpers.js';

/**
 * Production authentication boundary — the actual Better Auth library owns
 * the session lifecycle (sign-up / sign-in / session / sign-out over
 * `/api/auth/*`). Application authorization (workspace/resource isolation)
 * stays in the frozen resolver pipeline.
 *
 * These run with BHASYA_USE_AUTH=1 (production path). Local dev
 * (BHASYA_USE_AUTH unset) keeps the single seeded dev identity for the
 * validation loop / acceptance probe.
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

async function signIn(app: App, email: string) {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body, cookie: sessionCookieFrom(res) };
}

async function getSession(app: App, cookie: string) {
  const res = await app.request('/api/auth/get-session', { headers: { cookie } });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body };
}

async function signOut(app: App, cookie: string) {
  const res = await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie } });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body, cleared: sessionCookieFrom(res) };
}

async function callApp(app: App, path: string, init?: RequestInit) {
  const res = await app.request(path, { ...init, headers: { ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body };
}

const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, ...extra });

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

describe('production auth boundary (Better Auth library)', () => {
  it('unauthenticated request rejected (401)', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const noAuth = await callApp(app, '/api/sources');
      expect(noAuth.status).toBe(401);
      expect(String(noAuth.body.error)).toMatch(/unauthenticated/i);

      const noAuthPost = await callApp(app, '/api/sources/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/x' }),
      });
      expect(noAuthPost.status).toBe(401);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('authenticated Better Auth session resolves to the correct application user', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const up = await signUp(app, 'alice@bhasya.test', 'Alice');
      expect(up.status).toBe(200);
      expect(up.cookie).toContain('better-auth.session_token=');

      const sess = await getSession(app, up.cookie);
      expect(sess.status).toBe(200);
      const baUserId = String(sess.body?.user?.id ?? '');
      expect(baUserId.length).toBeGreaterThan(0);
      expect(String(sess.body?.user?.email ?? '').toLowerCase()).toBe('alice@bhasya.test');

      // Server-derived application identity linked to the Better Auth user.
      const identity = await getIdentityForRequest(db, new Headers({ cookie: up.cookie }));
      expect(identity).not.toBeNull();
      expect(identity?.email).toBe('alice@bhasya.test');
      const link = (await db.query(`SELECT id, external_user_id FROM users WHERE id = $1`, [identity!.userId])).rows[0] as any;
      expect(String(link.external_user_id)).toBe(baUserId);

      // HTTP path authenticates with the same session cookie.
      const res = await callApp(app, '/api/sources', { headers: withCookie(up.cookie) });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sources)).toBe(true);

      // Sign-out + sign-in resolves the SAME application user (stable link).
      const out = await signOut(app, up.cookie);
      expect(out.status).toBe(200);
      const back = await signIn(app, 'alice@bhasya.test');
      expect(back.status).toBe(200);
      const identity2 = await getIdentityForRequest(db, new Headers({ cookie: back.cookie }));
      expect(identity2?.userId).toBe(identity?.userId);
      expect(identity2?.workspaceId).toBe(identity?.workspaceId);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('logout invalidates the session', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const up = await signUp(app, 'carol@bhasya.test', 'Carol');
      expect(up.status).toBe(200);
      expect((await callApp(app, '/api/sources', { headers: withCookie(up.cookie) })).status).toBe(200);

      const out = await signOut(app, up.cookie);
      expect(out.status).toBe(200);

      // Old session cookie no longer authenticates.
      expect((await callApp(app, '/api/sources', { headers: withCookie(up.cookie) })).status).toBe(401);
      expect(await getIdentityForRequest(db, new Headers({ cookie: up.cookie }))).toBeNull();
      expect((await getSession(app, up.cookie)).body?.user ?? null).toBeNull();
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('spoofed identity headers/query parameters do not change identity', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const alice = await signUp(app, 'alice3@bhasya.test', 'Alice3');
      const bob = await signUp(app, 'bob3@bhasya.test', 'Bob3');
      expect(alice.status).toBe(200);
      expect(bob.status).toBe(200);

      const aliceId = (await getIdentityForRequest(db, new Headers({ cookie: alice.cookie })))!;
      const bobId = (await getIdentityForRequest(db, new Headers({ cookie: bob.cookie })))!;
      expect(aliceId.userId).not.toBe(bobId.userId);

      const svc = makeSvc(db);
      const ingBob = await (await import('../apps/api/src/services.js')).ingestSource(
        svc, bobId, 'https://example.com/craft-of-reading', { dnsResolve: publicDns },
      );
      const ingAlice = await ingestSample(svc, aliceId);

      // No session + spoof headers/query → still 401.
      const spoofs: Array<Record<string, string>> = [
        { 'x-dev-user': bobId.userId }, { 'x-user-id': bobId.userId }, { 'x-user-id': aliceId.userId },
      ];
      for (const headers of spoofs) {
        expect((await callApp(app, '/api/sources', { headers })).status).toBe(401);
      }
      expect((await callApp(app, `/api/sources?user=${bobId.userId}`)).status).toBe(401);

      // Valid Alice session + spoof claiming Bob → still Alice.
      const spoofed = await callApp(app, `/api/sources?user=${bobId.userId}`, {
        headers: withCookie(alice.cookie, { 'x-dev-user': bobId.userId, 'x-user-id': bobId.userId }),
      });
      expect(spoofed.status).toBe(200);
      const ids = (spoofed.body.sources as any[]).map((s) => String(s.id));
      expect(ids).toContain(String(ingAlice.sourceId));
      expect(ids).not.toContain(String(ingBob.sourceId));

      // Spoof cannot escalate to Bob's document either (still 404).
      const cross = await callApp(app, `/api/documents/${ingBob.versionId}?user=${bobId.userId}`, {
        headers: withCookie(alice.cookie, { 'x-dev-user': bobId.userId }),
      });
      expect(cross.status).toBe(404);

      // Invalid session cookies never authenticate, even with spoof headers.
      const bad = await getIdentityForRequest(
        db, new Headers({ cookie: 'better-auth.session_token=invalid-token-value-xyz-1234567890', 'x-dev-user': aliceId.userId }),
      );
      expect(bad).toBeNull();
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it("workspace authorization still isolates users (404, enumeration-safe)", async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();
      const alice = await signUp(app, 'alice2@bhasya.test', 'Alice2');
      const bob = await signUp(app, 'bob2@bhasya.test', 'Bob2');
      expect(alice.status).toBe(200);
      expect(bob.status).toBe(200);
      const aliceId = (await getIdentityForRequest(db, new Headers({ cookie: alice.cookie })))!;
      const bobId = (await getIdentityForRequest(db, new Headers({ cookie: bob.cookie })))!;
      void aliceId;

      const svc = makeSvc(db);
      const ing = await (await import('../apps/api/src/services.js')).ingestSource(
        svc, bobId, 'https://example.com/craft-of-reading', { dnsResolve: publicDns },
      );

      // Bob can read his own document.
      expect((await callApp(app, `/api/documents/${ing.versionId}`, { headers: withCookie(bob.cookie) })).status).toBe(200);

      // Alice gets 404 (not 403) — existence is not leaked across workspaces.
      expect((await callApp(app, `/api/documents/${ing.versionId}`, { headers: withCookie(alice.cookie) })).status).toBe(404);

      // Alice's sources list never includes Bob's workspace content.
      const list = await callApp(app, '/api/sources', { headers: withCookie(alice.cookie) });
      expect(list.status).toBe(200);
      expect((list.body.sources as any[]).map((s) => String(s.id))).not.toContain(String(ing.sourceId));
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});
