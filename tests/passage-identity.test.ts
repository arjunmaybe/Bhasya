import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';

/**
 * Cross-passage regression: the full identity chain must stay per-passage.
 *   Passage -> Anchor -> Highlight -> Thread -> Message -> Evidence -> Citation -> Passage
 * A must never resolve to B and B must never resolve to A. A single-passage
 * probe cannot catch a fixed/first-passage mixup, so this test uses TWO
 * DISTINCT passages and asserts both directions plus the shared version.
 */
describe('cross-passage identity (two distinct passages)', () => {
  it('Citation A -> Passage A and Citation B -> Passage B, never crossed', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const rows = (await svc.db.query(
        `SELECT id, text FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal`,
        [ing.versionId],
      )).rows as any[];
      expect(rows.length).toBeGreaterThanOrEqual(2);

      // First meaningful passage vs a later, clearly different passage.
      const pA = rows[0] as any;
      const pB = rows[rows.length - 1] as any;
      expect(String(pA.id)).not.toBe(String(pB.id));

      const selA = String(pA.text).split('. ')[0];
      const selB = String(pB.text).split('. ')[0];
      expect(selA.length).toBeGreaterThan(0);
      expect(selB.length).toBeGreaterThan(0);
      expect(selA).not.toBe(selB);

      // Anchor A -> Passage A, Anchor B -> Passage B (reader sends passageId).
      const aA = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selA, passageId: String(pA.id),
      });
      const aB = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selB, passageId: String(pB.id),
      });
      expect(aA.passageId).toBe(String(pA.id));
      expect(aB.passageId).toBe(String(pB.id));

      // Thread A / Thread B are distinct passage-scoped threads.
      const exA = await explainSelection(svc, identity, { anchorId: aA.anchorId });
      const exB = await explainSelection(svc, identity, { anchorId: aB.anchorId });
      expect(exA.threadId).not.toBe(exB.threadId);

      // Thread Message -> Evidence -> Passage -> Document Version (L0 only).
      async function l0CitationPassage(threadId: string): Promise<{ passageId: string; versionId: string }> {
        const r = (await svc.db.query(
          `SELECT e.passage_id, e.document_version_id FROM citations c
             JOIN evidence e ON e.id = c.evidence_id
             JOIN thread_messages m ON m.id = e.thread_message_id
            WHERE m.thread_id = $1 AND e.scope_level = 'L0'`,
          [threadId],
        )).rows as any[];
        expect(r.length).toBeGreaterThanOrEqual(1);
        return { passageId: String(r[0].passage_id), versionId: String(r[0].document_version_id) };
      }
      const cA = await l0CitationPassage(exA.threadId);
      const cB = await l0CitationPassage(exB.threadId);

      expect(cA.passageId).toBe(String(pA.id));
      expect(cB.passageId).toBe(String(pB.id));
      expect(cA.passageId).not.toBe(String(pB.id));
      expect(cB.passageId).not.toBe(String(pA.id));
      // Same document version for both (both originate from it).
      expect(cA.versionId).toBe(ing.versionId);
      expect(cB.versionId).toBe(ing.versionId);

      // Reader-facing resolution mirrors GET /api/citations/:id.
      const citesA = (await svc.db.query(
        `SELECT ci.id FROM citations ci JOIN evidence e ON e.id = ci.evidence_id
          JOIN thread_messages m ON m.id = e.thread_message_id WHERE m.thread_id = $1`,
        [exA.threadId],
      )).rows as any[];
      const resolved = (await svc.db.query(
        `SELECT e.passage_id FROM citations ci
           JOIN evidence e ON e.id = ci.evidence_id WHERE ci.id = $1`,
        [String(citesA[0].id)],
      )).rows[0] as any;
      expect(String(resolved.passage_id)).toBe(String(pA.id));
    } finally { await cleanup(); }
  });
});
