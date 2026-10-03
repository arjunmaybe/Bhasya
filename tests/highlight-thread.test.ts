import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';

describe('highlight + passage thread', () => {
  it('highlight references the anchor and survives persistence; thread is passage-scoped with model id', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'Readers who annotate remember more',
      });
      const ex = await explainSelection(svc, identity, { anchorId: anchor.anchorId });

      const hl = (await svc.db.query(`SELECT * FROM highlights WHERE anchor_id=$1`, [anchor.anchorId])).rows[0] as any;
      expect(hl).toBeTruthy(); // highlight auto-persisted on explain; separate object from thread

      const thread = (await svc.db.query(`SELECT * FROM threads WHERE id=$1`, [ex.threadId])).rows[0] as any;
      expect(thread.scope_type).toBe('passage');
      expect(String(thread.anchor_id)).toBe(anchor.anchorId);

      const msgs = (await svc.db.query(`SELECT role, model_id, content FROM thread_messages WHERE thread_id=$1 ORDER BY created_at`, [ex.threadId])).rows as any[];
      expect(msgs.length).toBe(2);
      expect(msgs[0].role).toBe('user');
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[1].model_id).toBeTruthy();
      expect(msgs[1].content).toContain('Readers who annotate remember more');

      // Messages are append-only (immutable).
      await expect(svc.db.query(`UPDATE thread_messages SET content='x' WHERE id=$1`, [msgs[1].id ?? ex.assistantMessageId])).rejects.toThrow(/immutable/);

      const ev = await svc.db.query(`SELECT event_type FROM event_log WHERE resource_id=$1`, [ex.threadId]);
      expect(ev.rows.map((r: any) => r.event_type)).toContain('thread_created');
    } finally { await cleanup(); }
  });
});
