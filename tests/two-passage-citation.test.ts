import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { createApp } from '../apps/api/src/app.js';
import { setServices } from '../apps/api/src/services.js';
import {
  buildMarkedSegments,
  findHighlightRanges,
  findSelectionRange,
} from '../apps/web/lib/highlight-render.js';
import { citationTargetPassageId } from '../apps/web/lib/explain-position.js';

/**
 * End-to-end two-passage regression through the REAL HTTP stack
 * (Hono app + service layer + PGlite), not source/CSS contract checks.
 *
 * Invariant under test:
 *   Passage A -> Anchor A -> Highlight A -> Thread A -> Evidence A -> Citation A -> Passage A
 *   Passage B -> Anchor B -> Highlight B -> Thread B -> Evidence B -> Citation B -> Passage B
 * with A != B at every step. Any collapse (first-passage mixup, shared
 * citation target, cross-rendered highlight, stale passage id) fails here.
 */
describe('two-passage citation/highlight end-to-end (HTTP, reload, render)', () => {
  it('A resolves to A and B resolves to B, never crossed', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const call = async (path: string, init?: RequestInit) => {
        const res = await app.request(path, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        });
        const body = (await res.json().catch(() => ({}))) as any;
        return { status: res.status, body };
      };

      const ing = await ingestSample(svc, identity);
      const rows = (
        await svc.db.query(
          `SELECT id, text FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal`,
          [ing.versionId],
        )
      ).rows as any[];
      expect(rows.length).toBeGreaterThanOrEqual(2);

      // Visibly distant passages: first vs last, with mutually exclusive selections.
      const pA = rows[0] as any;
      const pB = rows[rows.length - 1] as any;
      const passageA = String(pA.id);
      const passageB = String(pB.id);
      expect(passageA).not.toBe(passageB);

      const selA = 'rarest and purest form of generosity';
      const selB = 'Readers who annotate remember more';
      expect(String(pA.text)).toContain(selA);
      expect(String(pB.text)).toContain(selB);
      expect(String(pB.text)).not.toContain(selA);
      expect(String(pA.text)).not.toContain(selB);

      // ── selection -> anchor (server resolves canonical passage, not caller echo) ──
      const rA = await call('/api/anchors/resolve', {
        method: 'POST',
        body: JSON.stringify({ documentVersionId: ing.versionId, selectedText: selA, passageId: passageA }),
      });
      const rB = await call('/api/anchors/resolve', {
        method: 'POST',
        body: JSON.stringify({ documentVersionId: ing.versionId, selectedText: selB, passageId: passageB }),
      });
      expect(rA.status).toBe(201);
      expect(rB.status).toBe(201);
      const anchorA = String(rA.body.anchorId);
      const anchorB = String(rB.body.anchorId);
      expect(anchorA).not.toBe(anchorB);
      expect(String(rA.body.passageId)).toBe(passageA);
      expect(String(rB.body.passageId)).toBe(passageB);

      // Stale selected passage id must NOT silently resolve: B's text constrained
      // to passage A is a miss, not a cross-link.
      const stale = await call('/api/anchors/resolve', {
        method: 'POST',
        body: JSON.stringify({ documentVersionId: ing.versionId, selectedText: selB, passageId: passageA }),
      });
      expect(stale.status).not.toBe(201);

      // ── anchor -> thread + evidence + citation + highlight ──
      const eA = await call('/api/threads/explain', {
        method: 'POST',
        body: JSON.stringify({ anchorId: anchorA }),
      });
      const eB = await call('/api/threads/explain', {
        method: 'POST',
        body: JSON.stringify({ anchorId: anchorB }),
      });
      expect(eA.status).toBe(201);
      expect(eB.status).toBe(201);
      const threadA = String(eA.body.threadId);
      const threadB = String(eB.body.threadId);
      expect(threadA).not.toBe(threadB);
      expect(eA.body.citationIds.length).toBeGreaterThanOrEqual(1);
      expect(eB.body.citationIds.length).toBeGreaterThanOrEqual(1);
      const citeA = String(eA.body.citationIds[0]);
      const citeB = String(eB.body.citationIds[0]);
      expect(citeA).not.toBe(citeB);

      // ── GET citation -> passage_id (the exact reader click path) ──
      const cA = await call(`/api/citations/${citeA}`);
      const cB = await call(`/api/citations/${citeB}`);
      expect(cA.status).toBe(200);
      expect(cB.status).toBe(200);
      expect(citationTargetPassageId(cA.body.citation)).toBe(passageA);
      expect(citationTargetPassageId(cB.body.citation)).toBe(passageB);
      expect(String(cA.body.citation.passage_id)).not.toBe(String(cB.body.citation.passage_id));
      expect(String(cA.body.citation.document_version_id)).toBe(ing.versionId);
      expect(String(cB.body.citation.document_version_id)).toBe(ing.versionId);

      // Citation click endpoint stays reachable (reader fires it on navigation).
      expect((await call(`/api/citations/${citeA}/clicked`, { method: 'POST' })).status).toBe(200);
      expect((await call(`/api/citations/${citeB}/clicked`, { method: 'POST' })).status).toBe(200);

      // ── reload: highlights persist per passage ──
      const h1 = await call(`/api/documents/${ing.versionId}/highlights`);
      const h2 = await call(`/api/documents/${ing.versionId}/highlights`);
      expect(h1.status).toBe(200);
      expect(h2.status).toBe(200);
      const hls1 = h1.body.highlights as any[];
      const hls2 = h2.body.highlights as any[];
      expect(hls2.length).toBe(hls1.length);
      const hA = hls1.find((h) => String(h.anchor_id) === anchorA);
      const hB = hls1.find((h) => String(h.anchor_id) === anchorB);
      expect(hA).toBeTruthy();
      expect(hB).toBeTruthy();
      expect(String(hA.passage_id)).toBe(passageA);
      expect(String(hB.passage_id)).toBe(passageB);

      // ── reload: threads persist with their own explanations ──
      const tA = await call(`/api/threads/${threadA}`);
      const tB = await call(`/api/threads/${threadB}`);
      expect(tA.status).toBe(200);
      expect(tB.status).toBe(200);
      expect(tA.body.messages.length).toBe(2);
      expect(tB.body.messages.length).toBe(2);
      expect(String(tA.body.messages[1].content)).toBe(String(eA.body.text));
      expect(String(tB.body.messages[1].content)).toBe(String(eB.body.text));
      expect(String(tA.body.messages[1].content)).not.toBe(String(tB.body.messages[1].content));
      // Thread detail carries each thread's own citation set.
      const tAIds = new Set((tA.body.citations as any[]).map((c) => String(c.id)));
      const tBIds = new Set((tB.body.citations as any[]).map((c) => String(c.id)));
      expect(tAIds.has(citeA)).toBe(true);
      expect(tBIds.has(citeB)).toBe(true);
      expect(tAIds.has(citeB)).toBe(false);
      expect(tBIds.has(citeA)).toBe(false);

      // Citation still resolves after reload.
      const cA2 = await call(`/api/citations/${citeA}`);
      const cB2 = await call(`/api/citations/${citeB}`);
      expect(String(cA2.body.citation.passage_id)).toBe(passageA);
      expect(String(cB2.body.citation.passage_id)).toBe(passageB);

      // ── render: highlight A marks only A, highlight B marks only B ──
      // Same grouping the reader uses: passage-keyed lookup, never global.
      const hlByPassage = new Map<string, any[]>();
      for (const h of hls1) {
        const pid = String(h.passage_id);
        if (!hlByPassage.has(pid)) hlByPassage.set(pid, []);
        hlByPassage.get(pid)!.push(h);
      }
      const selsA = (hlByPassage.get(passageA) ?? []).map((h) => String(h.selected_text));
      const selsB = (hlByPassage.get(passageB) ?? []).map((h) => String(h.selected_text));
      expect(selsA).toContain(selA);
      expect(selsB).toContain(selB);
      expect(selsA).not.toContain(selB);
      expect(selsB).not.toContain(selA);

      const rangesAinA = findHighlightRanges(String(pA.text), selsA);
      const rangesBinB = findHighlightRanges(String(pB.text), selsB);
      expect(rangesAinA.length).toBeGreaterThanOrEqual(1);
      expect(rangesBinB.length).toBeGreaterThanOrEqual(1);
      // Cross-passage: A's selection marks nothing in B and vice versa.
      expect(findSelectionRange(String(pB.text), selA)).toBeNull();
      expect(findSelectionRange(String(pA.text), selB)).toBeNull();
      expect(findHighlightRanges(String(pB.text), selsA)).toEqual([]);
      expect(findHighlightRanges(String(pA.text), selsB)).toEqual([]);

      // Segments tile exactly (flash composes on top without breaking marks).
      const flashA = findSelectionRange(String(pA.text), selA);
      const segsA = buildMarkedSegments(String(pA.text), rangesAinA, flashA);
      expect(segsA.map((s) => String(pA.text).slice(s.start, s.end)).join('')).toBe(String(pA.text));
      expect(segsA.some((s) => s.marked)).toBe(true);
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});
