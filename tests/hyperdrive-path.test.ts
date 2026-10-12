import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { openDb, getAuthForDb, ensureBetterAuthSchema, type DbClient } from '@bhasya/db';
import { withTransaction } from '../db/transactions.js';
import { getServices, setServices } from '../apps/api/src/services.js';
import { bootEmbeddedPostgres } from './embedded-pg.js';

/**
 * Hyperdrive + direct transport path (both request-scoped pg.Client, nothing retained):
 * - direct DATABASE_URL is stateless (fresh Client per operation, no cached Pool);
 * - HYPERDRIVE binding selects the same stateless path with DATABASE_URL fallback;
 * - transactions commit/roll back on one checked-out connection;
 * - Better Auth (Kysely) operates through the same abstraction;
 * - sequential "requests" retain no backends.
 *
 * Real PostgreSQL over TCP (embedded-postgres). No Cloudflare account,
 * no Supabase, no secrets.
 */

const DEAD_URL = `postgres://bhasya:bhasya@127.0.0.1:1/nodead`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared cluster: one initdb+start per file (was: one per test, ~15s each,
 * ~73s per file alone). Boot itself is serialized across the two
 * embedded-Postgres files via tests/embedded-pg.ts (cross-process lock around
 * initdb+start only): concurrent initdb across parallel test files pushed a
 * single boot past the 60s per-test budget in the full suite. Each file still
 * gets its own isolated cluster (own dir/port/URL/tables), so isolation is
 * preserved. Client lifecycle is unchanged: every openDb/query still uses a
 * fresh pg.Client, no cached Pool.
 */
let sharedPgUrl!: string;
let sharedStop!: () => Promise<void>;

beforeAll(async () => {
  const boot = await bootEmbeddedPostgres('hdpath');
  sharedPgUrl = boot.pgUrl;
  sharedStop = boot.stop;
}, 60000);

afterAll(async () => {
  await sharedStop?.();
}, 60000);

async function backendCount(pgUrl: string): Promise<number> {
  const db = await openDb({ databaseUrl: pgUrl });
  try {
    // Scope to the current database: when the full suite reuses one shared
    // server with per-file databases (hdpath/hdlifecycle), neither file
    // observes the other's backends. Threshold unchanged (<=2).
    const r = await db.query(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'bhasya' AND datname = current_database()`,
    );
    return Number((r.rows[0] as any).n);
  } finally {
    await db.close?.();
  }
}

afterEach(() => { setServices(null); });

describe('hyperdrive transport path', () => {
  it('direct DATABASE_URL is stateless: fresh Client per operation, no cached Pool', async () => {
    const pgUrl = sharedPgUrl;
    {
      const db = await openDb({ databaseUrl: pgUrl });
      try {
        expect((db as { pool?: unknown }).pool).toBeFalsy();
        expect(db.hyperdrive).toBeFalsy();
        expect(typeof db.checkout).toBe('function');
        expect(typeof db.transact).toBe('function');
        const r = await db.query(`SELECT 1 AS one`);
        expect((r.rows[0] as any).one).toBe(1);
        await db.query(`CREATE TABLE direct_tx (id SERIAL PRIMARY KEY, v TEXT NOT NULL)`);
        await withTransaction(db, async (tx) => {
          await tx.query(`INSERT INTO direct_tx (v) VALUES ('keep')`);
        });
        await expect(withTransaction(db, async (tx) => {
          await tx.query(`INSERT INTO direct_tx (v) VALUES ('drop')`);
          throw new Error('rollback-me');
        })).rejects.toThrow('rollback-me');
        const rows = await db.query(`SELECT v FROM direct_tx ORDER BY v`);
        expect(rows.rows.map((r) => String((r as any).v))).toEqual(['keep']);
        await db.query(`DROP TABLE direct_tx`);
        await db.close?.();
      } finally {
        await db.close?.();
      }
      await sleep(100);
      // Nothing retained between "requests" beyond the counting connection itself.
      expect(await backendCount(pgUrl)).toBeLessThanOrEqual(2);
    }
  });

  it('hyperdrive DbClient is stateless: queries, tx commit/rollback, no retained backends', async () => {
    const pgUrl = sharedPgUrl;
    {
      const db = await openDb({ databaseUrl: pgUrl, hyperdrive: true });
      try {
        expect((db as { pool?: unknown }).pool).toBeFalsy();
        expect(db.hyperdrive).toBe(true);
        expect(typeof db.checkout).toBe('function');
        expect(typeof db.transact).toBe('function');
        await db.query(`CREATE TABLE hd_tx (id SERIAL PRIMARY KEY, v TEXT NOT NULL)`);
        await withTransaction(db, async (tx) => {
          await tx.query(`INSERT INTO hd_tx (v) VALUES ('keep')`);
        });
        await expect(withTransaction(db, async (tx) => {
          await tx.query(`INSERT INTO hd_tx (v) VALUES ('drop')`);
          throw new Error('rollback-me');
        })).rejects.toThrow('rollback-me');
        const rows = await db.query(`SELECT v FROM hd_tx ORDER BY v`);
        expect(rows.rows.map((r) => String((r as any).v))).toEqual(['keep']);
        await db.query(`DROP TABLE hd_tx`);
        await db.close?.();
      } finally {
        await db.close?.();
      }
      await sleep(100);
      // Nothing retained between "requests" beyond the counting connection itself.
      expect(await backendCount(pgUrl)).toBeLessThanOrEqual(2);
    }
  });

  it('Better Auth operates through the hyperdrive DbClient', async () => {
    const pgUrl = sharedPgUrl;
    {
      const db = await openDb({ databaseUrl: pgUrl, hyperdrive: true });
      try {
        await db.query(`CREATE TABLE IF NOT EXISTS hd_noop (id SERIAL PRIMARY KEY)`);
        await ensureBetterAuthSchema(db);
        const auth = await getAuthForDb(db, { env: { BETTER_AUTH_SECRET: 'bhasya-test-secret-0123456789abcdef-00000000', BETTER_AUTH_URL: 'http://localhost' } });
        const session = await auth.api.getSession({ headers: new Headers() });
        expect(session).toBeNull();
        await db.query(`DROP TABLE hd_noop`);
      } finally {
        await db.close?.();
      }
    }
  });

  it('getServices prefers HYPERDRIVE and falls back to DATABASE_URL', async () => {
    const pgUrl = sharedPgUrl;
    {
      // HYPERDRIVE valid + DATABASE_URL dead → succeeds via Hyperdrive.
      setServices(null);
      const viaHd = await getServices({
        env: { DATABASE_URL: DEAD_URL, HYPERDRIVE: { connectionString: pgUrl } },
      });
      expect(viaHd.db.hyperdrive).toBe(true);
      await viaHd.db.query(`SELECT 1`);
      setServices(null);

      // DATABASE_URL valid + HYPERDRIVE absent → succeeds via fallback (stateless, no Pool).
      const viaDirect = await getServices({ env: { DATABASE_URL: pgUrl } });
      expect(viaDirect.db.hyperdrive).toBeFalsy();
      expect((viaDirect.db as { pool?: unknown }).pool).toBeFalsy();
      expect(typeof viaDirect.db.checkout).toBe('function');
      expect(typeof viaDirect.db.transact).toBe('function');
      await viaDirect.db.query(`SELECT 1`);
      await viaDirect.db.close?.();
      setServices(null);

      // HYPERDRIVE present but unreachable → fails fast, never silently
      // falls back to DATABASE_URL (a hidden fallback would mask outages).
      setServices(null);
      await expect(getServices({
        env: { DATABASE_URL: pgUrl, HYPERDRIVE: { connectionString: DEAD_URL } },
      })).rejects.toThrow(/ECONNREFUSED|connect/);
      setServices(null);
    }
  });

  it('getServices still fails closed with neither source (message unchanged)', async () => {
    setServices(null);
    await expect(getServices({ env: { BHASYA_USE_AUTH: '1' } })).rejects.toThrow(/DATABASE_URL/);
    setServices(null);
  });
});
