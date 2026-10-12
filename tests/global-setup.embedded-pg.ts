import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFreePort, stopEmbeddedPostgres, waitForReady, sharedFilePath, type ManagedCluster } from './embedded-pg.js';

/**
 * Global setup: boot ONE embedded-Postgres cluster BEFORE any test file runs.
 *
 * Why: even serialized in-worker boots exceed the 60s beforeAll budget under
 * full-suite load (single initdb contended with ~32 PGlite/CPU-heavy files
 * takes >60s; observed: lock holder timed out at 60s, waiter at 40s). Booting
 * here runs serially before workers start, with no PGlite contention (~15s).
 * Both Hyperdrive files then reuse it with zero in-worker initdb cost.
 *
 * Isolation preserved: one server, TWO databases (`hdpath`, `hdlifecycle`).
 * Each file uses its own DB URL + own tables, and backendCount filters by
 * `current_database()`, so neither file observes the other's backends.
 * Client lifecycle unchanged (fresh pg.Client per op, no Pool).
 */

let sharedPg: ManagedCluster | null = null;
let sharedDir: string | null = null;
let sharedPort: number | null = null;

export async function setup(): Promise<void> {
  const t00 = performance.now();
  // Clean any stale shared file from a crashed run.
  try {
    rmSync(sharedFilePath, { force: true });
  } catch { /* ignore */ }
  const pgDir = mkdtempSync(join(tmpdir(), 'bhasya-shared-pg-'));
  sharedDir = pgDir;
  const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as unknown as {
    default: new (opts: Record<string, unknown>) => ManagedCluster;
  };
  const port = await getFreePort();
  sharedPort = port;
  const pgUrl = `postgres://bhasya:bhasya@127.0.0.1:${port}/postgres`;
  const pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'bhasya',
    password: 'bhasya',
    port,
    persistent: false,
  });
  await pg.initialise();
  const tInit = performance.now();
  await pg.start();
  const tStart = performance.now();
  await waitForReady(pgUrl);
  const { Client } = await import('pg');
  const admin = new Client({ connectionString: pgUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "hdpath"`);
    await admin.query(`CREATE DATABASE "hdlifecycle"`);
  } finally {
    await admin.end();
  }
  const hdpathUrl = `postgres://bhasya:bhasya@127.0.0.1:${port}/hdpath`;
  const hdlifecycleUrl = `postgres://bhasya:bhasya@127.0.0.1:${port}/hdlifecycle`;
  await waitForReady(hdpathUrl);
  await waitForReady(hdlifecycleUrl);
  writeFileSync(
    sharedFilePath,
    JSON.stringify({ pgUrl, hdpathUrl, hdlifecycleUrl, pgDir, port }),
    'utf8',
  );
  sharedPg = pg;
  console.log(
    `[embedded-pg:global-setup] initialise=${Math.round(tInit - t00)}ms ` +
      `start=${Math.round(tStart - tInit)}ms total=${Math.round(performance.now() - t00)}ms port=${port}`,
  );
}

export async function teardown(): Promise<void> {
  const s0 = performance.now();
  // Robust shutdown: awaited `pg_ctl stop -m fast` lets the postmaster reap
  // its children (no orphaned forkchild holding stdio pipes open, which kept
  // the Vitest main process alive: `close timed out after 10000ms`). Falls
  // back to the library stop + port/orphan sweep inside the helper.
  if (sharedPg && sharedDir && sharedPort !== null) {
    try {
      await stopEmbeddedPostgres({ pg: sharedPg, pgDir: sharedDir, port: sharedPort, prefix: 'global-setup' });
    } catch { /* ignore */ }
  } else {
    try {
      await sharedPg?.stop();
    } catch { /* ignore */ }
  }
  sharedPg = null;
  if (sharedDir) {
    try {
      rmSync(sharedDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    sharedDir = null;
  }
  sharedPort = null;
  try {
    rmSync(sharedFilePath, { force: true });
  } catch { /* ignore */ }
  // Best-effort cleanup of the boot lock dir if a worker crashed holding it.
  try {
    rmSync(join(tmpdir(), 'bhasya-embedded-pg-boot.lock.d'), { recursive: true, force: true });
  } catch { /* ignore */ }
  console.log(`[embedded-pg:global-setup] teardown=${Math.round(performance.now() - s0)}ms`);
}
