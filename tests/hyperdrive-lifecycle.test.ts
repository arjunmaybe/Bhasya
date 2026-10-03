import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';

/**
 * STEP 3 local proof: does the DB-client lifecycle (not credentials, not the
 * origin) explain why a cached pg.Pool breaks under a pooled transport with a
 * small origin budget (Hyperdrive, origin_connection_limit 20) while a
 * per-request pg.Client does not?
 *
 * Uses real PostgreSQL over TCP (embedded-postgres) with plain `pg` driver —
 * no Cloudflare account, no Supabase, no secrets. It cannot reproduce the
 * Supabase stall itself; it proves the resource-hold difference, which is the
 * exact mechanism behind budget exhaustion:
 *
 * - Path A (current architecture): one cached Pool holds open backends
 *   *between* requests, per isolate, with no upper bound across isolates.
 * - Path B (Hyperdrive guidance): a fresh Client per request holds zero
 *   backends between requests; the transport owns pooling.
 *
 * Also proves Kysely (Better Auth's adapter) works over a single client via a
 * minimal pool facade, including transaction commit/rollback.
 */

const pgUrlFor = (port: number) =>
  `postgres://bhasya:bhasya@127.0.0.1:${port}/postgres`;

/**
 * Allocate an ephemeral free TCP port via the OS (bind :0, read back, close).
 * `embedded-postgres` passes `-p <port>` through to `postgres` and only waits
 * for "ready to accept connections", so it cannot discover a port chosen via
 * `-p 0` itself — the caller must allocate first and build PG_URL from it.
 * Uses only `node:net` (no new dependency). Single allocation, no retries:
 * a startup bind failure surfaces instead of being hidden.
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

async function bootPg(prefix: string): Promise<{
  pg: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
  pgDir: string;
  port: number;
  url: string;
}> {
  const pgDir = mkdtempSync(join(tmpdir(), prefix));
  const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as any;
  const port = await getFreePort();
  const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'bhasya', password: 'bhasya', port, persistent: false });
  await pg.initialise();
  await pg.start();
  return { pg, pgDir, port, url: pgUrlFor(port) };
}

async function stopPg(pg: { stop(): Promise<void> }, pgDir: string): Promise<void> {
  try { await pg.stop(); } catch { /* ignore */ }
  try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function backendCount(pgUrl: string): Promise<number> {
  const admin = new Client({ connectionString: pgUrl });
  await admin.connect();
  try {
    const r = await admin.query(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'bhasya' AND datname = 'postgres'`,
    );
    return Number((r.rows[0] as any).n);
  } finally {
    await admin.end();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hyperdrive lifecycle proof (local TCP postgres)', () => {
  it('cached Pool holds backends between requests; per-request Client holds none', async () => {
    const { pg, pgDir, url: pgUrl } = await bootPg('bhasya-hd-');
    let pool: Pool | null = null;
    try {

      // Path A: one cached Pool serving two sequential "requests".
      pool = new Pool({ connectionString: pgUrl, max: 5 });
      await pool.query(`SELECT 1`);
      await pool.query(`SELECT 1`);
      expect(pool.totalCount).toBeGreaterThan(0);
      const heldAfterPool = await backendCount(pgUrl);
      await sleep(50);
      // Pool keeps its backends checked in (idle) between requests.
      expect(pool.totalCount).toBeGreaterThan(0);
      expect(heldAfterPool).toBeGreaterThanOrEqual(pool.totalCount);

      // Path B: fresh Client per request, ended after use.
      for (let i = 0; i < 2; i++) {
        const c = new Client({ connectionString: pgUrl });
        await c.connect();
        await c.query(`SELECT 1`);
        await c.end();
      }
      await sleep(100);
      const heldAfterClients = await backendCount(pgUrl);
      // No backends retained by Path B beyond the counting connection itself.
      expect(heldAfterClients).toBeLessThanOrEqual(2);
      // And the cached Pool still pins its own backends the whole time.
      expect(pool.totalCount).toBeGreaterThan(0);
    } finally {
      try { await pool?.end(); } catch { /* ignore */ }
      await stopPg(pg, pgDir);
    }
  });

  it('Kysely works over a single client via a minimal pool facade, with tx commit/rollback', async () => {
    const { pg, pgDir, url: pgUrl } = await bootPg('bhasya-hd-ky-');
    try {
      const client = new Client({ connectionString: pgUrl });
      await client.connect();
      try {
        // Minimal pool facade over one client: connect() checks out the same
        // client, release() is a no-op (lifecycle owned by the caller).
        const facade = {
          connect: async () => Object.assign(client, { release: () => undefined }),
          on: () => facade,
          end: async () => undefined,
        };
        const kysely = new Kysely({ dialect: new PostgresDialect({ pool: facade as unknown as Pool }) });
        await sql`CREATE TABLE IF NOT EXISTS hd_probe (id SERIAL PRIMARY KEY, v TEXT NOT NULL)`.execute(kysely);
        // Commit path.
        await kysely.transaction().execute(async (tx) => {
          await sql`INSERT INTO hd_probe (v) VALUES ('a')`.execute(tx);
        });
        // Rollback path.
        await expect(kysely.transaction().execute(async (tx) => {
          await sql`INSERT INTO hd_probe (v) VALUES ('b')`.execute(tx);
          throw new Error('boom');
        })).rejects.toThrow('boom');
        const rows = await sql`SELECT v FROM hd_probe ORDER BY v`.execute(kysely);
        expect(rows.rows.map((r: any) => r.v)).toEqual(['a']);
        await kysely.destroy();
      } finally {
        await client.end();
      }
    } finally {
      await stopPg(pg, pgDir);
    }
  });
});
