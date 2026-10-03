import { describe, expect, it } from 'vitest';
import { migrate, openDb, type DbClient } from '@bhasya/db';

/**
 * migrate() fast path: every Worker cold start runs migrate() before serving,
 * so the already-current case must stay cheap while fresh/partial databases
 * still get the full replay with an identical end state.
 */
async function tableNames(db: DbClient): Promise<Set<string>> {
  const r = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  return new Set(r.rows.map((row) => String((row as Record<string, unknown>)['tablename'])));
}

describe('migrate fast path', () => {
  it('full replay on a fresh database, cheap no-op on the second call, data preserved', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      await migrate(db);
      const first = await tableNames(db);
      for (const t of ['users', 'sources', 'document_versions', 'passages', 'event_log', 'auth_sessions', 'session']) {
        expect(first.has(t)).toBe(true);
      }
      const link = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'external_user_id'`,
      );
      expect(link.rows.length).toBe(1);

      // Seed a row, then migrate again (fast path): schema intact, data kept.
      await db.query(`INSERT INTO users (email, display_name) VALUES ($1,$2)`, ['fast@bhasya.test', 'Fast']);
      await migrate(db);
      const second = await tableNames(db);
      expect(second).toEqual(first);
      const kept = await db.query(`SELECT email FROM users WHERE email = $1`, ['fast@bhasya.test']);
      expect(kept.rows.length).toBe(1);
    } finally {
      await db.close?.();
    }
  });

  it('partial database still takes the full replay path', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      // Bare users table only (pre-migration shape): fast path must decline.
      await db.query(`CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE)`);
      await migrate(db);
      const names = await tableNames(db);
      for (const t of ['workspaces', 'sources', 'document_versions', 'event_log']) {
        expect(names.has(t)).toBe(true);
      }
    } finally {
      await db.close?.();
    }
  });
});
