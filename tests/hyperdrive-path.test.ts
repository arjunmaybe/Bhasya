import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getAuthForDb, ensureBetterAuthSchema, type DbClient } from '@bhasya/db';
import { withTransaction } from '../db/transactions.js';
import { getServices, setServices } from '../apps/api/src/services.js';

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

const pgUrlFor = (port: number) =>
  `postgres://bhasya:bhasya@127.0.0.1:${port}/postgres`;
const DEAD_URL = `postgres://bhasya:bhasya@127.0.0.1:1/nodead`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Allocate an ephemeral free TCP port via the OS (bind :0, read back, close).
 * Same mechanism as tests/hyperdrive-lifecycle.test.ts. `embedded-postgres`
 * cannot discover a `-p 0` port itself, so the caller allocates first and
 * builds PG_URL from the actual port. Uses only `node:net`; single
 * allocation, no retries.
 */
async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('failed to allocate a free TCP port for embedded postgres');
  return port;
}

async function bootPg() {
  const pgDir = mkdtempSync(join(tmpdir(), 'bhasya-hdpath-'));
  const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as any;
  const port = await getFreePort();
  const pgUrl = pgUrlFor(port);
  const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'bhasya', password: 'bhasya', port, persistent: false });
  await pg.initialise();
  await pg.start();
  return {
    pg, pgDir, pgUrl,
    stop: async () => {
      try { await pg.stop(); } catch { /* ignore */ }
      try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

async function backendCount(pgUrl: string): Promise<number> {
  const db = await openDb({ databaseUrl: pgUrl });
  try {
    const r = await db.query(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'bhasya' AND datname = 'postgres'`,
    );
    return Number((r.rows[0] as any).n);
  } finally {
    await db.close?.();
  }
}

afterEach(() => { setServices(null); });

describe('hyperdrive transport path', () => {
  it('direct DATABASE_URL is stateless: fresh Client per operation, no cached Pool', async () => {
    const { pgUrl, stop } = await bootPg();
    try {
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
    } finally {
      await stop();
    }
  });

  it('hyperdrive DbClient is stateless: queries, tx commit/rollback, no retained backends', async () => {
    const { pgUrl, stop } = await bootPg();
    try {
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
    } finally {
      await stop();
    }
  });

  it('Better Auth operates through the hyperdrive DbClient', async () => {
    const { pgUrl, stop } = await bootPg();
    try {
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
    } finally {
      await stop();
    }
  });

  it('getServices prefers HYPERDRIVE and falls back to DATABASE_URL', async () => {
    const { pgUrl, stop } = await bootPg();
    try {
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
    } finally {
      setServices(null);
      await stop();
    }
  });

  it('getServices still fails closed with neither source (message unchanged)', async () => {
    setServices(null);
    await expect(getServices({ env: { BHASYA_USE_AUTH: '1' } })).rejects.toThrow(/DATABASE_URL/);
    setServices(null);
  });
});
