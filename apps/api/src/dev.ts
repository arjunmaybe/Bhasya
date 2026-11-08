import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { getServices } from './services.js';

const port = Number(process.env.API_PORT ?? 8787);
const svc = await getServices(); // migrate + seed dev identity
const app = createApp();

serve({ fetch: app.fetch, port });
// Validation ops: which backends are actually serving this process.
// explain-contract identifies the loaded explanation prompt/renderer build:
// mismatch between this marker and browser behavior means a stale process.
console.log(
  `bhasya-api listening on :${port} ` +
  `db=${process.env.DATABASE_URL ? 'postgres' : 'pglite'} ` +
  `model=${svc.router.adapterId} ` +
  `explain-contract=content-task-v1`,
);

/**
 * Graceful shutdown (local dev only — production Worker lifecycle is owned by
 * Cloudflare and untouched).
 *
 * The filesystem-backed PGlite database must be closed cleanly so it can
 * checkpoint its WAL. A bare Ctrl+C kill leaves the data directory in an
 * interrupted state whose WAL recovery PANICs on the next start
 * (`RuntimeError: Aborted()` at `_pg_initdb`, "could not locate a valid
 * checkpoint record"), requiring the data directory to be quarantined.
 * Idempotent: concurrent signals close exactly once, then exit.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`bhasya-api received ${signal}, closing database...`);
  try {
    await svc.db.close?.();
  } catch (e) {
    console.error(`bhasya-api database close failed: ${String((e as Error)?.message ?? e)}`);
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
