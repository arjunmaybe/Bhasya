import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { resolveAnchor } from '../apps/api/src/services.js';

describe('anchoring', () => {
  it('maps selected text to the correct passage with version/node/passage refs', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const out = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId,
        selectedText: 'Attention is the rarest and purest form of generosity',
      });
      const row = (await svc.db.query(`SELECT * FROM anchors WHERE id=$1`, [out.anchorId])).rows[0] as any;
      expect(String(row.document_version_id)).toBe(ing.versionId);
      expect(String(row.passage_id)).toBe(out.passageId);
      expect(String(row.node_id)).toBe(out.nodeId);
      expect(row.start_offset).toBeGreaterThanOrEqual(0);
      expect(row.end_offset).toBeGreaterThan(row.start_offset);
      expect(row.text_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.context_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(row.structural_path).toMatch(/^\/doc\/sec\[\d+\]/);
      const locator = typeof row.locator === 'string' ? JSON.parse(row.locator) : row.locator;
      expect(locator.kind).toBe('web-html');
      expect(locator.passageId).toBe(out.passageId);
      // Anchor text is a substring of the referenced passage (L0 present).
      const p = (await svc.db.query(`SELECT text FROM passages WHERE id=$1`, [out.passageId])).rows[0] as any;
      expect(String(p.text)).toContain('Attention is the rarest');
    } finally { await cleanup(); }
  });

  it('rejects selections absent from the document version', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      await expect(resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'zzz no such sentence here',
      })).rejects.toThrow(/not found/);
    } finally { await cleanup(); }
  });
});
