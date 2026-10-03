import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  migrate, openDb,
  MemoryStorageAdapter, R2StorageAdapter, LocalStorageAdapter, SupabaseStorageAdapter,
  type DbClient, type StoragePort,
} from '@bhasya/db';
import {
  getServices, setServices, supabaseConfigFromEnv, SUPABASE_DEFAULT_BUCKET,
} from '../apps/api/src/services.js';

/**
 * $0 staging: Supabase Storage ONLY behind the existing StoragePort.
 * No R2 billing, no route/model/schema/auth changes. The application only
 * sees StoragePort.put/get and cannot distinguish Supabase from R2.
 */

const SUPABASE_URL = 'https://ref.supabase.co';
const SERVICE_KEY = 'service-role-key-for-tests-only';
const BUCKET = 'bhasya-artifacts';

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

type Captured = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };

/** In-memory Supabase Storage REST fake (private bucket: requires service key). */
function fakeSupabaseFetch(opts: { url?: string; serviceKey?: string; bucket?: string } = {}) {
  const base = (opts.url ?? SUPABASE_URL).replace(/\/+$/, '');
  const serviceKey = opts.serviceKey ?? SERVICE_KEY;
  const bucket = opts.bucket ?? BUCKET;
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const captured: Captured[] = [];
  const prefix = `${base}/storage/v1/object/${encodeURIComponent(bucket)}/`;

  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = String((init as { method?: string } | undefined)?.method ?? 'GET').toUpperCase();
    const rawHeaders = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    let body: Uint8Array | undefined;
    const rawBody = (init as { body?: unknown } | undefined)?.body;
    if (rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody);
    else if (typeof rawBody === 'string') body = new TextEncoder().encode(rawBody);
    captured.push({ url, method, headers, body });

    // Private bucket: every request must carry the server-side service key.
    if (headers['apikey'] !== serviceKey || headers['authorization'] !== `Bearer ${serviceKey}`) {
      return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 403 });
    }
    if (!url.startsWith(prefix)) {
      return new Response(JSON.stringify({ message: 'bad bucket' }), { status: 400 });
    }
    const key = url.slice(prefix.length).split('/').map((s) => decodeURIComponent(s)).join('/');
    if (method === 'POST') {
      if (headers['x-upsert'] !== 'true') {
        return new Response(JSON.stringify({ message: 'upsert required' }), { status: 400 });
      }
      store.set(key, { bytes: body ?? new Uint8Array(), contentType: headers['content-type'] ?? 'application/octet-stream' });
      return new Response(JSON.stringify({ Key: `${bucket}/${key}` }), { status: 200 });
    }
    if (method === 'GET') {
      const hit = store.get(key);
      if (!hit) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      return new Response(hit.bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': hit.contentType },
      });
    }
    return new Response('method not allowed', { status: 405 });
  }) as unknown as typeof fetch;

  return { fetchFn, store, captured, prefix };
}

/** Shared StoragePort contract: every backend must satisfy the same behavior. */
async function checkStoragePortContract(storage: StoragePort): Promise<void> {
  await storage.put('sources/a.html', '<html><body>hello</body></html>', 'text/html');
  const back = await storage.get('sources/a.html');
  expect(back).not.toBeNull();
  expect(new TextDecoder().decode(back!)).toContain('hello');

  const bytes = new Uint8Array([0, 1, 2, 255]);
  await storage.put('artifacts/bin', bytes, 'application/octet-stream');
  const raw = await storage.get('artifacts/bin');
  expect(raw).not.toBeNull();
  expect(Array.from(raw!)).toEqual([0, 1, 2, 255]);

  // Overwrite semantics (R2 put overwrites; Supabase uses x-upsert: true).
  await storage.put('sources/a.html', 'v2', 'text/plain');
  expect(new TextDecoder().decode((await storage.get('sources/a.html'))!)).toBe('v2');

  // Missing keys are null (never throw).
  expect(await storage.get('sources/does-not-exist.html')).toBeNull();
}

async function makeMemoryDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const db = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  return { db, cleanup: async () => { await db.close?.(); } };
}

/**
 * Deterministic env control: `supabaseConfigFromEnv` and `getServices` fall back
 * to `process.env` when a key is absent from the explicit `env` param, so any
 * real SUPABASE, BHASYA_USE_AUTH, or DATABASE_URL values inherited from the outer
 * shell would leak into tests (empty `env` ≠ empty config). Each test therefore
 * starts with those keys cleared and restores them afterward. Assertions below
 * are unchanged.
 */
const MANAGED_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'BHASYA_USE_AUTH',
  'DATABASE_URL',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  setServices(null);
});

afterEach(() => {
  for (const k of MANAGED_ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setServices(null);
});

describe('Supabase StoragePort contract ($0 staging, private bucket)', () => {
  it('satisfies the same StoragePort contract as R2 / memory (roundtrip, overwrite, missing → null)', async () => {
    const r2 = new R2StorageAdapter(fakeR2Bucket());
    await checkStoragePortContract(r2);

    const { fetchFn } = fakeSupabaseFetch();
    const supabase = new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn });
    await checkStoragePortContract(supabase);

    await checkStoragePortContract(new MemoryStorageAdapter());
  });

  it('R2StorageAdapter and LocalStorageAdapter remain intact', async () => {
    const bucket = fakeR2Bucket();
    const r2 = new R2StorageAdapter(bucket);
    await r2.put('sources/keep.html', 'r2-intact', 'text/html');
    expect(bucket.store.has('sources/keep.html')).toBe(true);
    expect(new TextDecoder().decode((await r2.get('sources/keep.html'))!)).toBe('r2-intact');
    expect(() => new R2StorageAdapter(null as unknown as never)).toThrow(/R2 bucket binding required/);

    // Local adapter is filesystem-backed (local dev only) and untouched.
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const local = new LocalStorageAdapter(join(mkdtempSync(join(tmpdir(), 'bhasya-obj-'))));
    await checkStoragePortContract(local);
  });

  it('uses Worker-safe Storage REST with private-bucket auth (service_role, never browser)', async () => {
    const { fetchFn, captured } = fakeSupabaseFetch();
    const s = new SupabaseStorageAdapter({ url: `${SUPABASE_URL}/`, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn });
    await s.put('sources/a.html', 'hi', 'text/html');
    const put = captured[captured.length - 1];
    expect(put.url).toBe(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/sources/a.html`);
    expect(put.headers['apikey']).toBe(SERVICE_KEY);
    expect(put.headers['authorization']).toBe(`Bearer ${SERVICE_KEY}`);
    expect(put.headers['x-upsert']).toBe('true');
    expect(put.headers['content-type']).toBe('text/html');

    captured.length = 0;
    await s.get('sources/a.html');
    const get = captured[captured.length - 1];
    expect(get.method).toBe('GET');
    expect(get.headers['apikey']).toBe(SERVICE_KEY);
    expect(get.headers['authorization']).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it('encodes object keys per path segment', async () => {
    const { fetchFn, captured } = fakeSupabaseFetch();
    const s = new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn });
    await s.put('sources/a b/c.html', 'x');
    expect(captured[captured.length - 1].url).toBe(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/sources/a%20b/c.html`,
    );
  });

  it('missing objects resolve to null (404 and private-bucket 400 "Not found")', async () => {
    const { fetchFn } = fakeSupabaseFetch();
    const s = new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn });
    expect(await s.get('sources/missing.html')).toBeNull();

    const notFound400 = (async () =>
      new Response(JSON.stringify({ message: 'Not found' }), { status: 400 })) as unknown as typeof fetch;
    const s400 = new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn: notFound400 });
    expect(await s400.get('sources/missing.html')).toBeNull();
  });

  it('surfaces storage errors (upload + download) instead of silent null', async () => {
    const boom: typeof fetch = (async () => new Response('db down', { status: 500 })) as unknown as typeof fetch;
    const s = new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn: boom });
    await expect(s.put('sources/a.html', 'x')).rejects.toThrow(/Supabase Storage upload failed \(500/);
    await expect(s.get('sources/a.html')).rejects.toThrow(/Supabase Storage download failed \(500/);
  });

  it('rejects requests without the service key (private bucket stays private)', async () => {
    const { fetchFn } = fakeSupabaseFetch();
    const wrongKey = new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: 'wrong-key', bucket: BUCKET, fetchFn });
    await expect(wrongKey.put('sources/a.html', 'x')).rejects.toThrow(/403/);
    await expect(wrongKey.get('sources/a.html')).rejects.toThrow(/403/);
  });

  it('validates constructor config (url + serviceKey + bucket)', () => {
    expect(() => new SupabaseStorageAdapter({ url: '', serviceKey: SERVICE_KEY, bucket: BUCKET })).toThrow(/requires url/);
    expect(() => new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: '', bucket: BUCKET })).toThrow(/requires url/);
    expect(() => new SupabaseStorageAdapter({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: '' })).toThrow(/requires url/);
  });
});

describe('storage selection (local → Local, staging → Supabase, prod R2 → R2)', () => {
  it('defaults the staging bucket to bhasya-artifacts', () => {
    expect(SUPABASE_DEFAULT_BUCKET).toBe('bhasya-artifacts');
    expect(supabaseConfigFromEnv({})).toBeNull();
    expect(supabaseConfigFromEnv({
      SUPABASE_URL, SUPABASE_SERVICE_KEY: SERVICE_KEY,
    })).toEqual({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: 'bhasya-artifacts' });
    expect(supabaseConfigFromEnv({
      SUPABASE_URL: `${SUPABASE_URL}/`, SUPABASE_SERVICE_KEY: SERVICE_KEY, SUPABASE_STORAGE_BUCKET: 'custom',
    })).toEqual({ url: `${SUPABASE_URL}/`, serviceKey: SERVICE_KEY, bucket: 'custom' });
  });

  it('partial Supabase config fails fast (never silently falls back)', () => {
    expect(() => supabaseConfigFromEnv({ SUPABASE_URL })).toThrow(/partially configured/);
    expect(() => supabaseConfigFromEnv({ SUPABASE_SERVICE_KEY: SERVICE_KEY })).toThrow(/partially configured/);
  });

  it('local dev without Supabase env → LocalStorageAdapter', async () => {
    const { db, cleanup } = await makeMemoryDb();
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;
      delete process.env.SUPABASE_STORAGE_BUCKET;
      setServices(null);
      const svc = await getServices({ env: {}, db });
      expect(svc.storage).toBeInstanceOf(LocalStorageAdapter);
      setServices(null);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('$0 staging (Supabase env, no R2) → SupabaseStorageAdapter', async () => {
    const { db, cleanup } = await makeMemoryDb();
    try {
      setServices(null);
      const svc = await getServices({
        env: { SUPABASE_URL, SUPABASE_SERVICE_KEY: SERVICE_KEY },
        db,
      });
      expect(svc.storage).toBeInstanceOf(SupabaseStorageAdapter);
      setServices(null);

      // Custom bucket is honored.
      const custom = await getServices({
        env: { SUPABASE_URL, SUPABASE_SERVICE_KEY: SERVICE_KEY, SUPABASE_STORAGE_BUCKET: 'custom-bucket' },
        db,
      });
      expect(custom.storage).toBeInstanceOf(SupabaseStorageAdapter);
      setServices(null);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('production with R2 binding → R2StorageAdapter (R2 wins over Supabase)', async () => {
    const { db, cleanup } = await makeMemoryDb();
    try {
      const bucket = fakeR2Bucket();
      setServices(null);
      const svc = await getServices({
        env: {
          BHASYA_USE_AUTH: '1',
          BHASYA_BUCKET: bucket,
          SUPABASE_URL,
          SUPABASE_SERVICE_KEY: SERVICE_KEY,
        },
        db,
      });
      expect(svc.storage).toBeInstanceOf(R2StorageAdapter);
      setServices(null);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('staging works in prod-auth mode without R2 (Supabase, no fail-closed)', async () => {
    const { db, cleanup } = await makeMemoryDb();
    try {
      setServices(null);
      const svc = await getServices({
        env: {
          BHASYA_USE_AUTH: '1',
          SUPABASE_URL,
          SUPABASE_SERVICE_KEY: SERVICE_KEY,
        },
        db,
      });
      expect(svc.storage).toBeInstanceOf(SupabaseStorageAdapter);
      setServices(null);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('production without R2 or Supabase still fails fast (never filesystem)', async () => {
    const { db, cleanup } = await makeMemoryDb();
    try {
      setServices(null);
      await expect(getServices({ env: { BHASYA_USE_AUTH: '1' }, db })).rejects.toThrow(/R2 bucket binding required/);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('application is backend-blind: ingest works unchanged on Supabase storage', async () => {
    const { fetchFn, store } = fakeSupabaseFetch();
    const injected = new SupabaseStorageAdapter({
      url: SUPABASE_URL, serviceKey: SERVICE_KEY, bucket: BUCKET, fetchFn,
    });
    const { db, cleanup } = await makeMemoryDb();
    try {
      const { ingestSource } = await import('../apps/api/src/services.js');
      const { seedDev } = await import('@bhasya/db');
      const seed = await seedDev(db);
      const identity = { ...seed, email: 'dev@bhasya.local' };
      const html = '<!doctype html><html><head><title>T</title></head><body><p>Attention is the rarest form of generosity.</p></body></html>';
      const svc = {
        db,
        storage: injected as StoragePort,
        router: new (await import('@bhasya/ai')).ModelRouter(new (await import('@bhasya/ai')).DevGroundedAdapter()),
        fetchFn: (async () => new Response(html, {
          status: 200, headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
      };
      const out = await ingestSource(svc, identity, 'https://example.com/t', { dnsResolve: async () => ['93.184.216.34'] });
      expect(out.versionId).toMatch(/^[0-9a-f-]{36}$/);
      const row = (await db.query(`SELECT storage_key FROM document_versions WHERE id = $1`, [out.versionId])).rows[0] as any;
      expect(String(row.storage_key)).toMatch(/^sources\//);
      // Bytes are retrievable through the same StoragePort the app used.
      const stored = await injected.get(String(row.storage_key));
      expect(stored).not.toBeNull();
      expect(store.size).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
