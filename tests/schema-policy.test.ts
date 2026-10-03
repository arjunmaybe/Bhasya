import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '@bhasya/db';

describe('schema policy (frozen 001)', () => {
  it('canonical tables, immutability triggers, and key constraints exist', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      const { migrate } = await import('@bhasya/db');
      await migrate(db);
      const tables = (await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
      )).rows.map((r: any) => r.table_name);
      for (const t of ['workspaces', 'sources', 'document_versions', 'document_nodes', 'passages',
        'anchors', 'highlights', 'threads', 'thread_messages', 'evidence', 'citations', 'embeddings', 'event_log']) {
        expect(tables).toContain(t);
      }
      const triggers = (await db.query(
        `SELECT trigger_name FROM information_schema.triggers`,
      )).rows.map((r: any) => r.trigger_name);
      for (const t of ['trg_immutable_doc_versions', 'trg_immutable_doc_nodes', 'trg_immutable_passages', 'trg_immutable_messages']) {
        expect(triggers).toContain(t);
      }
      const evCols = (await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='evidence'`,
      )).rows.map((r: any) => r.column_name);
      expect(evCols).toContain('document_version_id');
      const citeCols = (await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='citations'`,
      )).rows.map((r: any) => r.column_name);
      expect(citeCols).toContain('evidence_id');
      expect(citeCols).toContain('anchor_id');
      expect(citeCols).not.toContain('document_version_id'); // version authority lives in evidence, not citation

      // Frozen policy file ships with the repo.
      const policy = readFileSync(join(process.cwd(), 'db', 'tests', 'schema_policy_tests.sql'), 'utf8');
      expect(policy).toMatch(/trg_immutable_doc_versions/);
    } finally { await db.close?.(); }
  });
});
