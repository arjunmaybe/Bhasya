import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';

describe('evidence + citation', () => {
  it('evidence points to the generation passage/version; citation points to evidence and resolves back', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'Memory keeps what attention touches',
      });
      const ex = await explainSelection(svc, identity, { anchorId: anchor.anchorId });

      const ev = (await svc.db.query(
        `SELECT e.*, p.document_version_id AS pver FROM evidence e JOIN passages p ON p.id = e.passage_id
          WHERE e.thread_message_id=$1 ORDER BY e.rank`, [ex.assistantMessageId],
      )).rows as any[];
      expect(ev.length).toBeGreaterThanOrEqual(1);
      expect(String(ev[0].passage_id)).toBe(anchor.passageId);
      expect(String(ev[0].document_version_id)).toBe(ing.versionId);
      expect(String(ev[0].pver)).toBe(ing.versionId); // passage belongs to the evidence version
      expect(ev[0].scope_level).toBe('L0');

      const cites = (await svc.db.query(
        `SELECT c.*, e.passage_id AS e_pass, e.document_version_id AS e_ver FROM citations c JOIN evidence e ON e.id=c.evidence_id
          WHERE c.id = ANY($1::uuid[])`, [ex.citationIds],
      )).rows as any[];
      expect(cites.length).toBe(ex.citationIds.length);
      expect(String(cites[0].e_pass)).toBe(anchor.passageId);
      expect(String(cites[0].e_ver)).toBe(ing.versionId);

      // Inconsistent relationships fail: evidence to a nonexistent passage.
      await expect(svc.db.query(
        `INSERT INTO evidence (thread_message_id, passage_id, document_version_id, scope_level) VALUES ($1,$2,$3,'L0')`,
        [ex.assistantMessageId, '00000000-0000-0000-0000-000000000000', ing.versionId],
      )).rejects.toThrow();

      // Assistant messages require a model id.
      await expect(svc.db.query(
        `INSERT INTO thread_messages (thread_id, role, content) VALUES ($1,'assistant','x')`, [ex.threadId],
      )).rejects.toThrow();
    } finally { await cleanup(); }
  });
});
