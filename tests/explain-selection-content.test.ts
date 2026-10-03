import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';

/**
 * Same-passage selection regression (deterministic, dev-grounded-1 only).
 *
 * Two DIFFERENT user selections inside the SAME passage must produce
 * explanations conditioned on their own selection — not one shared response.
 * Both threads/citations still resolve to that same passage (identity intact).
 */
describe('explain conditions on the exact selection within one passage', () => {
  it('selection A -> explanation A, selection B -> explanation B, same passage', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const rows = (await svc.db.query(
        `SELECT id, text FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal`,
        [ing.versionId],
      )).rows as any[];
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // One passage containing two clearly different selections.
      const selA = 'rarest and purest form of generosity';
      const selB = 'To attend fully to a passage';
      const prow = rows.find(
        (r) => String(r.text).includes(selA) && String(r.text).includes(selB),
      ) as any;
      expect(prow).toBeTruthy();
      const passageId = String(prow.id);
      expect(selA).not.toBe(selB);

      // Reader sends passageId with each selection; constrain both anchors
      // to the SAME passage (mirrors the browser flow).
      const aA = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selA, passageId,
      });
      const aB = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selB, passageId,
      });
      expect(aA.passageId).toBe(passageId);
      expect(aB.passageId).toBe(passageId);
      expect(aA.anchorId).not.toBe(aB.anchorId);

      // Selection persisted verbatim on each anchor.
      const persisted = (await svc.db.query(
        `SELECT id, passage_id, selected_text FROM anchors WHERE id = ANY($1)`,
        [[aA.anchorId, aB.anchorId]],
      )).rows as any[];
      const rowA = persisted.find((r) => String(r.id) === aA.anchorId);
      const rowB = persisted.find((r) => String(r.id) === aB.anchorId);
      expect(String(rowA.selected_text)).toBe(selA);
      expect(String(rowB.selected_text)).toBe(selB);
      expect(String(rowA.passage_id)).toBe(passageId);
      expect(String(rowB.passage_id)).toBe(passageId);

      const exA = await explainSelection(svc, identity, { anchorId: aA.anchorId });
      const exB = await explainSelection(svc, identity, { anchorId: aB.anchorId });
      expect(exA.modelId).toBe('dev-grounded-1');
      expect(exB.modelId).toBe('dev-grounded-1');
      expect(exA.threadId).not.toBe(exB.threadId);

      // Each explanation reflects its own selection — never one fixed text.
      expect(String(exA.text)).toContain(selA);
      expect(String(exB.text)).toContain(selB);
      expect(String(exA.text)).not.toBe(String(exB.text));

      // Citation/evidence still resolve to the SAME passage for both.
      async function l0Passage(threadId: string): Promise<string> {
        const r = (await svc.db.query(
          `SELECT e.passage_id FROM citations c
             JOIN evidence e ON e.id = c.evidence_id
             JOIN thread_messages m ON m.id = e.thread_message_id
            WHERE m.thread_id = $1 AND e.scope_level = 'L0'`,
          [threadId],
        )).rows as any[];
        expect(r.length).toBeGreaterThanOrEqual(1);
        return String(r[0].passage_id);
      }
      expect(await l0Passage(exA.threadId)).toBe(passageId);
      expect(await l0Passage(exB.threadId)).toBe(passageId);
    } finally {
      await cleanup();
    }
  });
});
