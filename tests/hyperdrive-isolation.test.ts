import { describe, expect, it, afterEach } from 'vitest';
import { Client, Pool } from 'pg';
import { openDb } from '@bhasya/db';
import { withTransaction } from '../db/transactions.js';
import { getServices, setServices } from '../apps/api/src/services.js';

/**
 * Hyperdrive + direct request-isolation regression (deterministic).
 *
 * Contract (Hyperdrive implementation already exists; direct fixed to match):
 * 1. HYPERDRIVE binding wins when present (DATABASE_URL ignored).
 * 2. DATABASE_URL fallback is stateless (fresh Client per operation, no
 *    cached Pool) — same lifecycle as Hyperdrive, fix for Worker stale-TCP
 *    reuse (services-level fallback end-to-end stays covered live in
 *    tests/hyperdrive-path.test.ts; here both branch shapes are pinned
 *    without opening sockets).
 * 3. Two invocations sharing the SAME cached Services facade (the Worker
 *    `init = getServices({ env })` + routes `getServices()` pattern) check
 *    out distinct pg.Client instances.
 * 4-5. Each checked-out client is ended; B is a different instance from A.
 * 6. No pg.Pool is constructed/used on either pg path.
 * 7. A transaction holds ONE client from BEGIN through COMMIT.
 * 8. The cached facade retains no raw Client/Pool/socket.
 *
 * No network, no ports, no sleeps, no Supabase/Cloudflare credentials:
 * pg.Client TCP is stubbed at the prototype (per-checkout instance tracking)
 * and pg.Pool.query is armed to throw if ever touched on this path.
 */

const HD_FAKE = 'postgres://bhasya:bhasya@127.0.0.1:1/hd-fake';
const DEAD_URL = 'postgres://bhasya:bhasya@127.0.0.1:1/nodead';
const DIRECT_FAKE = 'postgres://bhasya:bhasya@127.0.0.1:1/direct-fake';

// Mirrors packages/db/src/index.ts MIGRATED_APP_TABLES + MIGRATED_AUTH_TABLES
// so migrate() takes its current-schema fast path against the stub.
const APP_TABLES = [
  'users', 'workspaces', 'workspace_members', 'sources', 'document_versions',
  'document_nodes', 'passages', 'anchors', 'highlights', 'threads',
  'thread_messages', 'evidence', 'citations', 'embeddings', 'event_log',
  'auth_sessions',
];
const AUTH_TABLES = ['user', 'session', 'account', 'verification'];

type SpyState = {
  nextId: number;
  ids: WeakMap<object, string>;
  connects: string[];
  queries: Array<{ id: string; text: string }>;
  ends: string[];
  poolQueryUsed: boolean;
};

const state: SpyState = {
  nextId: 0,
  ids: new WeakMap(),
  connects: [],
  queries: [],
  ends: [],
  poolQueryUsed: false,
};

const origClientConnect = (Client.prototype as any).connect;
const origClientQuery = (Client.prototype as any).query;
const origClientEnd = (Client.prototype as any).end;
const origPoolQuery = (Pool.prototype as any).query;

const ENV_KEYS = [
  'BHASYA_USE_AUTH',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_STORAGE_BUCKET',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function rowsFor(sql: string): Array<Record<string, unknown>> {
  if (sql.includes('pg_tables')) {
    return [...APP_TABLES, ...AUTH_TABLES].map((t) => ({ tablename: t }));
  }
  if (sql.includes('information_schema') && sql.includes('external_user_id')) {
    return [{ column_name: 'external_user_id' }];
  }
  if (/\busers\b/.test(sql) && sql.includes('email')) {
    return [{ id: 'user-1', email: 'dev@bhasya.local' }];
  }
  if (sql.includes('workspaces') && sql.includes('owner_user_id')) {
    return [{ id: 'ws-1' }];
  }
  if (sql.startsWith('SELECT 1')) {
    return [{ one: 1 }];
  }
  return [];
}

function installSpies(): void {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  state.nextId = 0;
  state.connects = [];
  state.queries = [];
  state.ends = [];
  state.poolQueryUsed = false;

  (Client.prototype as any).connect = async function (this: object) {
    const id = `hd-${++state.nextId}`;
    state.ids.set(this, id);
    state.connects.push(id);
  };
  (Client.prototype as any).query = async function (this: object, text: unknown) {
    const id = state.ids.get(this) ?? 'unknown';
    const sql = String(text);
    state.queries.push({ id, text: sql.slice(0, 80) });
    const rows = rowsFor(sql);
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
  };
  (Client.prototype as any).end = async function (this: object) {
    const id = state.ids.get(this) ?? 'unknown';
    state.ends.push(id);
  };
  (Pool.prototype as any).query = function () {
    state.poolQueryUsed = true;
    throw new Error('POOL_USED: Hyperdrive path must not use pg.Pool');
  };
}

function restoreSpies(): void {
  (Client.prototype as any).connect = origClientConnect;
  (Client.prototype as any).query = origClientQuery;
  (Client.prototype as any).end = origClientEnd;
  (Pool.prototype as any).query = origPoolQuery;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setServices(null);
}

afterEach(() => {
  restoreSpies();
});

describe('hyperdrive cached-Services request isolation (mocked pg.Client)', () => {
  it('shared cached facade checks out distinct ended clients; tx holds one client; no Pool', async () => {
    installSpies();
    try {
      // 2. Direct branch shape (fallback target): stateless, never hyperdrive flag.
      // Construction opens no sockets; close() is a facade no-op.
      const direct = await openDb({ databaseUrl: DIRECT_FAKE });
      try {
        expect(direct.hyperdrive).toBeFalsy();
        expect((direct as { pool?: unknown }).pool).toBeFalsy();
        expect(typeof (direct as { checkout?: unknown }).checkout).toBe('function');
        expect(typeof (direct as { transact?: unknown }).transact).toBe('function');
        // Direct shares the stateless lifecycle: two sequential uses check out
        // distinct ended clients (no stale reuse across "requests").
        const dMark = state.connects.length;
        await direct.query('SELECT 1 /* direct-A */');
        await direct.query('SELECT 1 /* direct-B */');
        const dConnects = state.connects.slice(dMark);
        expect(dConnects).toHaveLength(2);
        expect(dConnects[1]).not.toBe(dConnects[0]);
        expect(state.ends).toContain(dConnects[0]);
        expect(state.ends).toContain(dConnects[1]);
      } finally {
        await direct.close?.();
      }
      expect(state.poolQueryUsed).toBe(false);

      // 1. HYPERDRIVE wins even when DATABASE_URL is present (dead here, so
      // success proves the Hyperdrive string was used, not DATABASE_URL).
      // Pool.query is armed to throw, so success also proves no Pool use.
      setServices(null);
      const svc = await getServices({
        env: { DATABASE_URL: DEAD_URL, HYPERDRIVE: { connectionString: HD_FAKE } },
      });
      expect(svc.db.hyperdrive).toBe(true);
      expect((svc.db as { pool?: unknown }).pool).toBeFalsy();
      expect(typeof svc.db.checkout).toBe('function');
      expect(typeof svc.db.transact).toBe('function');

      // Routes call getServices() with no args: same cached facade.
      const viaRoute = await getServices();
      expect(viaRoute).toBe(svc);

      // 3/4/5. Invocations A and B share the facade, get distinct clients,
      // each ended.
      const mark = state.connects.length;
      await svc.db.query('SELECT 1 /* invocation-A */');
      await svc.db.query('SELECT 1 /* invocation-B */');
      const freshConnects = state.connects.slice(mark);
      expect(freshConnects).toHaveLength(2);
      const [idA, idB] = freshConnects;
      expect(idB).not.toBe(idA);
      expect(state.ends).toContain(idA);
      expect(state.ends).toContain(idB);

      // 7. Transaction holds ONE client from BEGIN through COMMIT.
      const txMark = state.connects.length;
      await withTransaction(svc.db, async (tx) => {
        await tx.query('INSERT a');
        await tx.query('INSERT b');
      });
      const txConnects = state.connects.slice(txMark);
      expect(txConnects).toHaveLength(1);
      const txId = txConnects[0];
      const txOps = state.queries.filter((q) => q.id === txId).map((q) => q.text);
      expect(txOps.some((t) => t.includes('BEGIN'))).toBe(true);
      expect(txOps.some((t) => t.includes('INSERT a'))).toBe(true);
      expect(txOps.some((t) => t.includes('INSERT b'))).toBe(true);
      expect(txOps.some((t) => t.includes('COMMIT'))).toBe(true);
      expect(state.ends).toContain(txId);

      // 6. No Pool constructed/used anywhere on the Hyperdrive path.
      expect(state.poolQueryUsed).toBe(false);
      expect((svc.db as { pool?: unknown }).pool).toBeFalsy();

      // 8. Facade retains no raw Client/Pool/socket; every checkout ended.
      expect(Object.keys(svc.db).join(',')).not.toMatch(/client|socket/i);
      expect((svc.db as { pglite?: unknown }).pglite).toBeFalsy();
      expect(state.ends).toHaveLength(state.connects.length);
      expect(new Set(state.ends)).toEqual(new Set(state.connects));

      // close() is a facade no-op and must not break sharing.
      await svc.db.close?.();
      expect((await getServices())).toBe(svc);
    } finally {
      restoreSpies();
    }
  });
});
