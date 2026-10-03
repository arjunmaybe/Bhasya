import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { migrate, openDb, getIdentityForRequest, MemoryStorageAdapter, type DbClient } from '@bhasya/db';
import { DevGroundedAdapter, ModelRouter } from '@bhasya/ai';
import { createApp } from '../apps/api/src/app.js';
import { setServices, type Services } from '../apps/api/src/services.js';
import { mockFetch } from './helpers.js';

/**
 * Bearer session boundary — Better Auth `bearer()` plugin.
 *
 * Without the plugin, `GET /api/auth/get-session` with only
 * `Authorization: Bearer <token>` returns HTTP 200 with body `null`
 * (the session is cookie-addressed only). With the plugin, the Bearer
 * token is converted to the session cookie before endpoints run, so both
 * the Better Auth endpoint and the app identity boundary
 * (`auth.api.getSession({ headers })` in `getIdentityForRequest`) accept
 * Bearer tokens as well as cookies.
 *
 * Runs on the production path (BHASYA_USE_AUTH=1). Email/password and
 * cookie sessions are unchanged.
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

async function signUp(app: App, email: string, name: string) {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body, token: res.headers.get('set-auth-token') };
}

async function getSessionBearer(app: App, token: string) {
  const res = await app.request('/api/auth/get-session', {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body };
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

describe('bearer session boundary (Better Auth bearer plugin)', () => {
  it('sign-up creates a session with a bearer token', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const up = await signUp(app, 'bearer1@bhasya.test', 'Bearer1');
      expect(up.status).toBe(200);
      expect(up.token).toBeTruthy();
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('get-session with Authorization: Bearer returns the user/session', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const up = await signUp(app, 'bearer2@bhasya.test', 'Bearer2');
      expect(up.status).toBe(200);
      const token = up.token!;

      // Better Auth endpoint accepts the Bearer token (was HTTP 200 + null).
      const sess = await getSessionBearer(app, token);
      expect(sess.status).toBe(200);
      expect(String(sess.body?.user?.email ?? '').toLowerCase()).toBe('bearer2@bhasya.test');
      expect(String(sess.body?.session?.token ?? '').length).toBeGreaterThan(0);

      // App identity boundary accepts the same Bearer token (no cookies).
      const identity = await getIdentityForRequest(db, new Headers({ authorization: `Bearer ${token}` }));
      expect(identity).not.toBeNull();
      expect(identity?.email).toBe('bearer2@bhasya.test');

      // Authenticated app route works with Bearer alone.
      const res = await app.request('/api/sources', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('unauthenticated get-session remains null', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const anon = await app.request('/api/auth/get-session');
      expect(anon.status).toBe(200);
      expect(await anon.json().catch(() => 'parse-fail')).toBeNull();

      expect(await getIdentityForRequest(db, new Headers())).toBeNull();

      const bad = await getSessionBearer(app, 'invalid-token-value-xyz-1234567890');
      expect(bad.status).toBe(200);
      expect(bad.body).toBeNull();
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('logout invalidates the bearer session', async () => {
    const { db, cleanup } = await makeProdDb();
    try {
      setServices(makeSvc(db));
      const app = createApp();

      const up = await signUp(app, 'bearer3@bhasya.test', 'Bearer3');
      expect(up.status).toBe(200);
      const token = up.token!;
      expect((await getSessionBearer(app, token)).body?.user).toBeTruthy();

      const out = await app.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(out.status).toBe(200);

      // Bearer token no longer resolves a session anywhere.
      expect((await getSessionBearer(app, token)).body).toBeNull();
      expect(await getIdentityForRequest(db, new Headers({ authorization: `Bearer ${token}` }))).toBeNull();
      expect((await app.request('/api/sources', {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(401);
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});
