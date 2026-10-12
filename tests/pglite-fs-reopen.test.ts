import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@bhasya/db';

/**
 * Filesystem-backed PGlite graceful-reopen regression (tmpdir-isolated).
 *
 * Local dev (`apps/api/src/dev.ts`, no DATABASE_URL) persists PGlite to a
 * filesystem data directory. An unclean shutdown (Ctrl+C with no `close()`)
 * leaves the WAL un-checkpointed and the next start PANICs in WAL recovery
 * (`RuntimeError: Aborted()` at `_pg_initdb`, "could not locate a valid
 * checkpoint record"). The dev server now closes the database on
 * SIGINT/SIGTERM; this test locks in the underlying guarantee: a cleanly
 * closed filesystem database reopens with its data intact.
 *
 * Never touches `apps/api/.bhasya-pglite`: each run gets a fresh `os.tmpdir()`
 * directory, removed afterwards. Deterministic, no network, no timeout or
 * assertion changes elsewhere.
 */
describe('pglite filesystem graceful reopen (tmpdir isolated)', () => {
  it('open → write → close cleanly → reopen → data intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bhasya-pglite-fs-'));
    const db1 = await openDb({ dataDir: dir });
    try {
      await db1.query(`CREATE TABLE fs_reopen_probe (id SERIAL PRIMARY KEY, v TEXT NOT NULL)`);
      await db1.query(`INSERT INTO fs_reopen_probe (v) VALUES ('persist-me')`);
    } finally {
      // Graceful close checkpoints the WAL — the exact step a bare Ctrl+C
      // used to skip for the local dev database.
      await db1.close?.();
    }
    const db2 = await openDb({ dataDir: dir });
    try {
      const rows = await db2.query(`SELECT v FROM fs_reopen_probe ORDER BY id`);
      expect(rows.rows.map((r) => String((r as Record<string, unknown>).v))).toEqual(['persist-me']);
      await db2.query(`DROP TABLE fs_reopen_probe`);
    } finally {
      await db2.close?.();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });
});
