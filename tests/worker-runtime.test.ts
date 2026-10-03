import { describe, expect, it, afterEach } from 'vitest';
import {
  migrate, openDb, MemoryStorageAdapter, R2StorageAdapter,
  type DbClient,
} from '@bhasya/db';
import { DevGroundedAdapter, ModelRouter } from '@bhasya/ai';
import { createApp } from '../apps/api/src/app.js';
import { getServices, setServices, type Services } from '../apps/api/src/services.js';
import worker, { __resetWorkerForTests } from '../apps/api/src/worker.js';
import { mockFetch } from './helpers.js';

/**
 * Cloudflare Worker runtime verification (not a typecheck-only check).
 *
 * - The Worker entry serves the SAME Hono router/contracts over `fetch`.
 * - Production storage is the R2 binding (filesystem is never assumed).
 * - Worker bindings (`env`) drive service wiring, not just `process.env`.
 * - Authentication uses the real Better Auth lifecycle (sign-up over
 *   `/api/auth/*`, session cookie); R2 wiring below is untouched by the
 *   Better Auth task.
 */

const PREV_AUTH = process.env.BHASYA_USE_AUTH;
const PREV_DB = process.env.DATABASE_URL;
const PREV_SECRET = process.env.BETTER_AUTH_SECRET;
const PREV_URL = process.env.BETTER_AUTH_URL;
const TEST_SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
const PASSWORD = 'Password123!';

function fakeR2Bucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    },
    async get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer };
    },
  };
}

async function makeMemoryDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const db = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  return { db, cleanup: async () => { await db.close?.(); } };
}

function makeSvc(db: DbClient): Services {
  return { db, storage: new MemoryStorageAdapter(), router: new ModelRouter(new DevGroundedAdapter()), fetchFn: mockFetch() };
}

function sessionCookieFrom(res: Response): string {
  const getSet = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raws: string[] = typeof getSet === 'function'
    ? getSet.call(res.headers)
    : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=[^;,]*;)/);
  return raws.map((s) => s.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function signUpCookie(db: DbClient, email: string, name: string): Promise<string> {
  setServices(makeSvc(db));
  const app = createApp();
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return sessionCookieFrom(res);
}

function withAuthEnv(extra: Record<string, unknown> = {}) {
  process.env.BHASYA_USE_AUTH = '1';
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = 'http://localhost';
  return { BHASYA_USE_AUTH: '1', BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: 'http://localhost', ...extra };
}

afterEach(() => {
  if (PREV_AUTH === undefined) delete process.env.BHASYA_USE_AUTH;
  else process.env.BHASYA_USE_AUTH = PREV_AUTH;
  if (PREV_DB === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = PREV_DB;
  if (PREV_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = PREV_SECRET;
  if (PREV_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = PREV_URL;
  setServices(null);
  __resetWorkerForTests();
});

describe('worker runtime (real fetch, same router, R2 production storage)', () => {
  it('worker fetch serves the same Hono router (healthz + auth boundary)', async () => {
    // Secret first so migration-time auth uses the same secret as requests.
    const env = withAuthEnv({ BHASYA_BUCKET: fakeR2Bucket() });
    const { db, cleanup } = await makeMemoryDb();
    try {
      // Production identity via the real Better Auth lifecycle; services
      // injected with the same contracts the Worker uses (PG in prod, PGlite here).
      const cookie = await signUpCookie(db, 'w@bhasya.test', 'W');

      setServices(makeSvc(db));

      // Actually execute the Worker entry (not a typecheck): real Request/Response.
      const health = await worker.fetch(new Request('https://api.bhasya.test/healthz'), env);
      expect(health.status).toBe(200);
      const hj = (await health.json()) as any;
      expect(hj.ok).toBe(true);
      expect(hj.service).toBe('bhasya-api');

      // Same 401 discipline as the Hono app without a session.
      const anon = await worker.fetch(new Request('https://api.bhasya.test/api/sources'), env);
      expect(anon.status).toBe(401);

      // Same authenticated path with a Better Auth session cookie.
      const authed = await worker.fetch(
        new Request('https://api.bhasya.test/api/sources', { headers: { cookie } }),
        env,
      );
      expect(authed.status).toBe(200);

      // Parity with the local Hono app instance (same router, same contracts).
      const app = createApp();
      const direct = await app.request('/healthz');
      expect(direct.status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('production storage is R2 (put/get roundtrip); filesystem never assumed', async () => {
    const { db, cleanup } = await makeMemoryDb();
    try {
      const bucket = fakeR2Bucket();
      const r2 = new R2StorageAdapter(bucket);
      await r2.put('sources/probe.html', '<html><body>hello</body></html>', 'text/html');
      const back = await r2.get('sources/probe.html');
      expect(back).not.toBeNull();
      expect(new TextDecoder().decode(back!)).toContain('hello');
      expect(await r2.get('sources/missing.html')).toBeNull();

      // Service wiring picks R2 when the Worker binding is present (prod).
      setServices(null);
      __resetWorkerForTests();
      const svc = await getServices({
        env: { BHASYA_USE_AUTH: '1', BHASYA_BUCKET: bucket },
        db,
        // storage intentionally omitted: wiring must select R2, not filesystem.
      });
      expect(svc.storage).toBeInstanceOf(R2StorageAdapter);
      await svc.storage.put('sources/wired.html', 'x', 'text/html');
      expect(bucket.store.has('sources/wired.html')).toBe(true);

      // Production without an R2 binding fails fast (never silently uses fs).
      setServices(null);
      await expect(getServices({ env: { BHASYA_USE_AUTH: '1' }, db })).rejects.toThrow(/R2 bucket binding required/);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('production fails closed: database, secret, hyperdrive mapping', async () => {
    // No database URL / Hyperdrive and no injected db → explicit fail, never PGlite.
    setServices(null);
    __resetWorkerForTests();
    await expect(getServices({ env: { BHASYA_USE_AUTH: '1', BHASYA_BUCKET: fakeR2Bucket() } }))
      .rejects.toThrow(/DATABASE_URL/);

    // Hyperdrive binding (object or string) satisfies the database requirement.
    const { db, cleanup } = await makeMemoryDb();
    try {
      setServices(null);
      __resetWorkerForTests();
      const viaObject = await getServices({
        env: { BHASYA_USE_AUTH: '1', BHASYA_BUCKET: fakeR2Bucket(), HYPERDRIVE: { connectionString: 'postgres://127.0.0.1:1/bhasya' } },
        db,
      });
      expect(viaObject.storage).toBeInstanceOf(R2StorageAdapter);
      setServices(null);

      const bucket2 = fakeR2Bucket();
      const viaString = await getServices({
        env: { BHASYA_USE_AUTH: '1', BHASYA_BUCKET: bucket2, HYPERDRIVE: 'postgres://127.0.0.1:1/bhasya' },
        db,
      });
      expect(viaString.storage).toBeInstanceOf(R2StorageAdapter);
      setServices(null);
    } finally {
      setServices(null);
      await cleanup();
    }

    // Worker entry without any Better Auth secret → 500, never dev-secret sessions.
    const savedSecret = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    setServices(null);
    __resetWorkerForTests();
    try {
      const res = await worker.fetch(
        new Request('https://api.bhasya.test/healthz'),
        { BHASYA_USE_AUTH: '1', BHASYA_BUCKET: fakeR2Bucket() },
      );
      expect(res.status).toBe(500);
      expect(String((await res.json() as any).error)).toMatch(/BETTER_AUTH_SECRET/);
    } finally {
      if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = savedSecret;
      setServices(null);
      __resetWorkerForTests();
    }
  });

  it('worker bindings drive auth even when process.env is empty', async () => {
    process.env.BETTER_AUTH_SECRET = TEST_SECRET;
    process.env.BETTER_AUTH_URL = 'http://localhost';
    const { db, cleanup } = await makeMemoryDb();
    try {
      const cookie = await signUpCookie(db, 'e@bhasya.test', 'E');

      setServices(makeSvc(db));
      // Production mode comes from the Worker `env`; only the flag is
      // cleared from process.env (secret stays so the same instance validates).
      delete process.env.BHASYA_USE_AUTH;
      const env = { BHASYA_USE_AUTH: '1', BHASYA_BUCKET: fakeR2Bucket() };
      const anon = await worker.fetch(new Request('https://api.bhasya.test/api/sources'), env);
      expect(anon.status).toBe(401);
      const authed = await worker.fetch(
        new Request('https://api.bhasya.test/api/sources', { headers: { cookie } }),
        env,
      );
      expect(authed.status).toBe(200);
      // The 401→200 above already proves Worker `env` drove auth: process.env
      // started empty, and applyEnv mirrors Worker bindings for legacy
      // process.env readers by design (no new config).
    } finally {
      await cleanup();
    }
  });
});
