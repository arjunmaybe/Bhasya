import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';

/**
 * Follow-up regression (deterministic, dev-grounded-1 only).
 *
 * Initial: selection A -> explanation T0.
 * Follow-up: same thread + NEW question Q -> NEW answer T1 conditioned on Q,
 * grounded in the same selection/passage — never a repeat of T0.
 */
describe('thread follow-up answers the new question', () => {
  it('follow-up Q produces a Q-conditioned answer in the same thread', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selA,
      });

      const initial = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
      const T0 = String(initial.text);
      expect(initial.modelId).toBe('dev-grounded-1');
      expect(T0).toContain(selA);

      const Q = 'Can you give me a concrete example?';
      const follow = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: Q, threadId: initial.threadId,
      });
      const T1 = String(follow.text);

      // Same thread, same anchor/passage retained.
      expect(follow.threadId).toBe(initial.threadId);
      expect(follow.modelId).toBe('dev-grounded-1');

      // New answer, observably different — and Q-conditioned, not just different.
      expect(T1).not.toBe(T0);
      expect(T1).toContain('concrete example');
      expect(T1).toContain(Q);
      // Still grounded in the selected passage.
      expect(T1).toContain(selA);

      // Thread now holds initial pair + follow-up pair.
      const msgs = (await svc.db.query(
        `SELECT role, content, model_id FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`,
        [initial.threadId],
      )).rows as any[];
      expect(msgs.length).toBe(4);
      expect(msgs[0].role).toBe('user');
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[2].role).toBe('user');
      expect(String(msgs[2].content)).toBe(Q);
      expect(msgs[3].role).toBe('assistant');
      expect(String(msgs[3].content)).toBe(T1);
      expect(String(msgs[3].model_id)).toBe('dev-grounded-1');

      // Anchor/passage ownership unchanged; follow-up evidence still L0 on it.
      const thread = (await svc.db.query(`SELECT anchor_id FROM threads WHERE id = $1`, [initial.threadId])).rows[0] as any;
      expect(String(thread.anchor_id)).toBe(anchor.anchorId);
      const l0 = (await svc.db.query(
        `SELECT e.passage_id FROM citations c
           JOIN evidence e ON e.id = c.evidence_id
           JOIN thread_messages m ON m.id = e.thread_message_id
          WHERE m.id = $1 AND e.scope_level = 'L0'`,
        [follow.assistantMessageId],
      )).rows as any[];
      expect(l0.length).toBeGreaterThanOrEqual(1);
      expect(String(l0[0].passage_id)).toBe(anchor.passageId);
    } finally {
      await cleanup();
    }
  });
});
