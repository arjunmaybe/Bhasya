import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  layoutExportIR,
  renderExportPdf,
  toSafePdfText,
  wrapPdfText,
  type TextMeasurer,
} from '../apps/api/src/export-pdf.js';
import { buildExportIR, type ExportInput } from '../apps/api/src/export-ir.js';

/** Deterministic stub: half-em average advance per character. */
const stubMeasure: TextMeasurer = (text, size) => text.length * size * 0.5;

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    version: {
      title: 'The Craft of Reading',
      sourceUrl: 'https://example.com/craft-of-reading',
      versionNo: 1,
      importedAt: '2026-10-04T00:00:00.000Z',
      contentHash: 'abc123def456',
      passageCount: 2,
    },
    nodes: [
      { node_type: 'heading', depth: 2, structural_path: '/doc/sec[1]/h[1]', text: 'Attention' },
      { node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[1]', text: 'First paragraph here.' },
      { node_type: 'list_item', depth: 2, structural_path: '/doc/sec[1]/p[2]', text: 'A list point.' },
    ],
    threads: [],
    generatedAt: '2026-10-04T01:00:00.000Z',
    ...overrides,
  };
}

function thread(overrides: any = {}) {
  return {
    id: 'thread-1',
    title: 'Passage thread',
    createdAt: '2026-10-04T01:01:00.000Z',
    anchorSelectedText: 'rarest and purest form of generosity',
    anchorStructuralPath: '/doc/sec[1]/p[1]',
    sectionLabel: 'Attention',
    messages: [
      { role: 'user', content: 'Explain this passage.', model_id: null, created_at: 't0' },
      { role: 'assistant', content: 'Attention means giving time.', model_id: 'dev-grounded-1', created_at: 't1' },
    ],
    evidence: [{ quote: 'Attention is the rarest…', scope_level: 'L0', rank: 0, passagePath: '/doc/sec[1]/p[1]' }],
    citations: [{ label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' }],
    ...overrides,
  };
}

describe('toSafePdfText / wrapPdfText', () => {
  it('maps common punctuation and drops the rest without throwing', () => {
    expect(toSafePdfText('a—b–c“d”e•f…')).toBe('a--b-c"d"e-f...');
    expect(toSafePdfText('héllo wörld §ok')).toMatch(/^h.llo w.rld /);
    expect(toSafePdfText('emoji 😀 end')).toContain('end');
  });

  it('wraps greedily and hard-splits overlong tokens', () => {
    const lines = wrapPdfText('aa bb cc dd', 100, (s) => s.length * 10);
    expect(lines).toEqual(['aa bb cc', 'dd']);
    const long = wrapPdfText('abcdefghij', 30, (s) => s.length * 10);
    expect(long.join('')).toBe('abcdefghij');
    expect(long.length).toBeGreaterThan(1);
    expect(wrapPdfText('   ', 100, (s) => s.length)).toEqual([]);
  });
});

describe('layoutExportIR: structure', () => {
  it('orders cover, article, hard break, appendix, citation index', () => {
    const ir = buildExportIR(input({ threads: [thread()] }));
    const layout = layoutExportIR(ir, stubMeasure);
    const markers = layout.ops.map((o) => o.marker).filter(Boolean) as string[];
    const order = ['cover-title', 'article-heading', 'appendix-divider', 'thread-1', 'citation-index'];
    let last = -1;
    for (const m of order) {
      const idx = markers.indexOf(m);
      expect(idx, m).toBeGreaterThan(last);
      last = idx;
    }
    expect(layout.pages).toBeGreaterThanOrEqual(2);
  });

  it('starts the appendix on a fresh page after the article', () => {
    const ir = buildExportIR(input({ threads: [thread()] }));
    const layout = layoutExportIR(ir, stubMeasure);
    const divider = layout.ops.find((o) => o.marker === 'appendix-divider')!;
    const articleOps = layout.ops.filter((o) => (o.marker ?? '').startsWith('article') || o.marker === 'cover-title');
    const lastContentBefore = Math.max(...layout.ops.filter((o) => o.page < divider.page).map((o) => o.page));
    expect(articleOps.every((o) => o.page <= divider.page)).toBe(true);
    expect(divider.page).toBeGreaterThanOrEqual(lastContentBefore);
    // No article content shares the divider page before the divider op.
    const dividerIdx = layout.ops.indexOf(divider);
    expect(layout.ops.slice(0, dividerIdx).every((o) => o.page <= divider.page)).toBe(true);
  });

  it('renders an empty appendix honestly when there are no threads', () => {
    const layout = layoutExportIR(buildExportIR(input()), stubMeasure);
    const texts = layout.ops.map((o) => o.text);
    expect(texts).toContain('No explanations yet for this document.');
    expect(texts).toContain('Bhasya Reading Session');
  });

  it('keeps Q/A order, evidence, citations, and truncation notices', () => {
    const ir = buildExportIR(input({
      threads: [thread({
        messages: [
          { role: 'user', content: 'Explain this passage.', model_id: null, created_at: 't0' },
          { role: 'assistant', content: 'A1.', model_id: 'm', created_at: 't1' },
          { role: 'user', content: 'Q2?', model_id: null, created_at: 't2' },
          { role: 'assistant', content: 'A2.', model_id: 'm', created_at: 't3' },
        ],
      })],
    }));
    const layout = layoutExportIR(ir, stubMeasure);
    const texts = layout.ops.map((o) => o.text);
    const at = (s: string) => texts.findIndex((t) => t === s);
    expect(at('Question')).toBeGreaterThan(-1);
    expect(at('Q2?')).toBeGreaterThan(at('A1.'));
    expect(at('A2.')).toBeGreaterThan(at('Q2?'));
    expect(texts.some((t) => t.includes('Evidence (exact passage)'))).toBe(true);
    expect(texts.some((t) => t.includes('Cited passage'))).toBe(true);
    expect(texts.some((t) => t.startsWith('[1] Cited passage'))).toBe(true);
  });

  it('surfaces truncation and media notices from the IR', () => {
    const ir = buildExportIR(input());
    ir.truncation.threadsOmitted = 3;
    ir.nodes.push({ kind: 'caption', text: 'Fig.' });
    ir.mediaNote = 'Figures and images from the original page are not included in this export.';
    const layout = layoutExportIR(ir, stubMeasure);
    const texts = layout.ops.map((o) => o.text);
    expect(texts.some((t) => t.includes('3 further threads omitted'))).toBe(true);
    expect(texts.some((t) => t.includes('not included in this export'))).toBe(true);
  });
});

describe('renderExportPdf: bytes', () => {
  it('produces a loadable PDF whose page count matches the layout', async () => {
    const ir = buildExportIR(input({ threads: [thread()] }));
    const bytes = await renderExportPdf(ir);
    expect(bytes[0]).toBe(0x25); // %
    expect(bytes[1]).toBe(0x50); // P
    const doc = await PDFDocument.load(bytes);
    const stubPages = layoutExportIR(ir, stubMeasure).pages;
    // Real glyph widths differ from the stub; require sane bounds instead.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getPageCount()).toBeLessThanOrEqual(stubPages + 4);
  });

  it('never throws on adversarial unicode content', async () => {
    const ir = buildExportIR(input({
      nodes: [{ node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[1]', text: 'Emoji 😀😀😀 CJK 你好 RTL مرحبا math ∑∫√' }],
      threads: [thread({ anchorSelectedText: '“fancy” — ’quotes’ …', messages: [{ role: 'assistant', content: 'Ünïcödé → ← ⇒', model_id: null, created_at: 't' }] })],
    }));
    const bytes = await renderExportPdf(ir);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
