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
    it('maps common punctuation and transliterates accented text', () => {
    expect(toSafePdfText('a—b–c“d”e•f…'))
      .toBe('a--b-c"d"e-f...');

    expect(toSafePdfText('héllo wörld §ok'))
      .toBe('hello world S. ok');

    expect(toSafePdfText('Encyclopédie'))
      .toBe('Encyclopedie');

    expect(toSafePdfText('emoji 😀 end'))
      .toContain('end');

    expect(toSafePdfText('emoji 😀 end'))
      .toContain('?');
  });

    it('preserves readable representations of fractions, currency and mathematics', () => {
    expect(toSafePdfText('⅜ ¼ ½ ¾'))
      .toBe('3/8 1/4 1/2 3/4');

    expect(toSafePdfText('£500'))
      .toBe('GBP 500');

    expect(toSafePdfText('2ρgL4/(Ed2)'))
      .toBe('2rhogL4/(Ed2)');
  });

  it('transliterates interface symbols and punctuation', () => {
    expect(toSafePdfText('⌘/Ctrl'))
      .toBe('Cmd/Ctrl');

    expect(toSafePdfText('By Gary Linscott · Discuss:'))
      .toBe('By Gary Linscott - Discuss:');
  });

  it('maps footnote markers and arrows to deliberate ASCII', () => {
    expect(toSafePdfText('Return↩ here ⇒ done')).toBe('Return<- here => done');
    expect(toSafePdfText('a⇐b⇔c↔d↑e↓f')).toBe('a<=b<=>c<->d^evf');
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

  // ADD THIS NEW TEST HERE
  it('numbers footnotes sequentially but preserves ordinary list bullets', () => {
    const ir = buildExportIR(input({
      nodes: [
        { node_type: 'heading', depth: 1, structural_path: '/doc/sec[1]/h[1]', text: 'Article' },
        { node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[1]', text: 'Article body.' },
        { node_type: 'heading', depth: 1, structural_path: '/doc/sec[2]/h[2]', text: 'Footnotes' },
        { node_type: 'list_item', depth: 2, structural_path: '/doc/sec[2]/p[1]', text: 'First footnote.' },
        { node_type: 'list_item', depth: 2, structural_path: '/doc/sec[2]/p[2]', text: 'Second footnote.' },
        { node_type: 'heading', depth: 1, structural_path: '/doc/sec[3]/h[3]', text: 'Sources & credits' },
        { node_type: 'list_item', depth: 2, structural_path: '/doc/sec[3]/p[1]', text: 'First source.' },
      ],
    }));

    const layout = layoutExportIR(ir, stubMeasure);
    const texts = layout.ops.map((o) => o.text);

    expect(texts).toContain('1. First footnote.');
    expect(texts).toContain('2. Second footnote.');
    expect(texts).toContain('- First source.');
    expect(texts).not.toContain('- First footnote.');
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

  it('keeps provenance on the cover and never creates a source-metadata-only page', () => {
    // Sweeps article lengths so the old trailing Source block would land on
    // a page tail (it then occupied a page of its own before the appendix).
    for (let fill = 0; fill <= 60; fill += 1) {
      const filler = Array.from({ length: fill }, (_, i) => ({
        node_type: 'paragraph',
        depth: 2,
        structural_path: `/doc/sec[1]/p[${i + 1}]`,
        text: `Filler paragraph ${i + 1}.`,
      }));
      const ir = buildExportIR(input({ nodes: filler, threads: [thread()] }));
      const layout = layoutExportIR(ir, stubMeasure);
      const cover = layout.ops.filter((o) => o.page === 1).map((o) => o.text);
      expect(cover.some((t) => t.includes('Content hash: abc123def456'))).toBe(true);
      expect(layout.ops.some((o) => o.marker === 'source-heading')).toBe(false);
      for (let p = 2; p <= layout.pages; p += 1) {
        const pageOps = layout.ops.filter((o) => o.page === p);
        const sourceOnly = pageOps.length > 0 && pageOps.every((o) =>
          o.marker === 'source-heading' ||
          o.text === ir.document.sourceUrl ||
          o.text.startsWith('Version ') ||
          o.text.startsWith('Content hash:'),
        );
        expect(sourceOnly, `fill=${fill} page ${p} holds only source metadata`).toBe(false);
      }
    }
  });

  it('renders duplicate evidence and citations once per thread, keeping distinct entries', () => {
    const ir = buildExportIR(input({
      threads: [thread({
        evidence: [
          { quote: 'Same quote.', scope_level: 'L0', rank: 0, passagePath: '/doc/sec[1]/p[1]' },
          { quote: 'Same  quote.', scope_level: 'L0', rank: 1, passagePath: '/doc/sec[1]/p[1]' },
          { quote: 'Same quote.', scope_level: 'L0', rank: 2, passagePath: '/doc/sec[1]/p[1]' },
          { quote: 'Same quote.', scope_level: 'L1', rank: 3, passagePath: '/doc/sec[1]/p[1]' },
          { quote: 'Related quote.', scope_level: 'L1', rank: 4, passagePath: '/doc/sec[1]/p[2]' },
        ],
        citations: [
          { label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' },
          { label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' },
          { label: 'Cited passage', passagePath: '/doc/sec[1]/p[2]' },
        ],
      })],
    }));
    const layout = layoutExportIR(ir, stubMeasure);
    const texts = layout.ops.map((o) => o.text);
    // Exact-passage duplicates collapse; same quote at another scope stays.
    expect(texts.filter((t) => t === 'Same quote.')).toHaveLength(2);
    expect(texts.filter((t) => t === 'Related quote.')).toHaveLength(1);
    // Citation index keeps one entry per distinct citation in this thread.
    expect(texts.filter((t) => t === '[1] Cited passage (thread 1)')).toHaveLength(1);
    expect(texts.filter((t) => t === '[2] Cited passage (thread 1)')).toHaveLength(1);
    // Persisted messages are untouched by presentation dedupe.
    expect(texts).toContain('Attention means giving time.');
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

    it('keeps short paragraphs together when they fit on a fresh page', () => {
    const targetText = 'TARGETLINE '.repeat(35).trim();

    for (let fill = 0; fill <= 60; fill += 1) {
      const filler = Array.from({ length: fill }, (_, i) => ({
        node_type: 'paragraph',
        depth: 2,
        structural_path: `/doc/sec[1]/p[${i + 1}]`,
        text: `FILLER${i + 1} `.repeat(12),
      }));

      const target = {
        node_type: 'paragraph',
        depth: 2,
        structural_path: `/doc/sec[1]/p[${fill + 1}]`,
        text: targetText,
      };

      const ir = buildExportIR(input({ nodes: [...filler, target] }));
      const layout = layoutExportIR(ir, stubMeasure);

      const targetOps = layout.ops.filter((op) =>
        op.text.includes('TARGETLINE'),
      );

      expect(targetOps.length).toBeGreaterThan(1);
      expect(
        new Set(targetOps.map((op) => op.page)).size,
        `paragraph split with ${fill} preceding paragraphs`,
      ).toBe(1);
    }
  });

  it('keeps headings with the start of their body (no stranded headings)', () => {
    const sections = Array.from({ length: 24 }, (_, s) => [
      { node_type: 'heading', depth: 2, structural_path: `/doc/sec[${s + 1}]/h[${s + 1}]`, text: `Part ${s + 1}` },
      ...Array.from({ length: 4 }, (_, p) => ({
        node_type: 'paragraph', depth: 2, structural_path: `/doc/sec[${s + 1}]/p[${p + 1}]`,
        text: `Body paragraph ${p + 1} of part ${s + 1}, with enough words to wrap across lines.`,
      })),
    ]).flat();
    const ir = buildExportIR(input({
      nodes: sections,
      threads: [
        thread(),
        thread({ id: 'thread-2', anchorSelectedText: 'second topic here', anchorStructuralPath: '/doc/sec[2]/p[1]' }),
      ],
    }));
    const layout = layoutExportIR(ir, stubMeasure);
    expect(layout.pages).toBeGreaterThan(2);
    const ops = layout.ops;
    const headings = ops
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => (o.size === 14 || o.size === 13) && o.font === 'bold' && o.marker !== 'cover-contents');
    expect(headings.length).toBeGreaterThan(0);
    for (const { o, i } of headings) {
      const next = ops[i + 1];
      expect(next, `heading "${o.text}" stranded at a page bottom`).toBeTruthy();
      expect(next.page).toBe(o.page);
    }
  });

  it('starts the appendix with its first thread on the divider page', () => {
    const ir = buildExportIR(input({
      threads: [
        thread(),
        thread({ id: 'thread-2', anchorSelectedText: 'second topic here', anchorStructuralPath: '/doc/sec[2]/p[1]' }),
      ],
    }));
    const layout = layoutExportIR(ir, stubMeasure);
    const divider = layout.ops.find((o) => o.marker === 'appendix-divider')!;
    const firstTitle = layout.ops.find((o) => o.marker === 'thread-1')!;
    expect(divider).toBeTruthy();
    expect(firstTitle.page).toBe(divider.page);
  });

  it('renders locations without raw structural paths or model ids', () => {
    const ir = buildExportIR(input({
      threads: [thread({ sectionLabel: 'Attention', anchorLeafOrdinal: 1 })],
    }));
    const layout = layoutExportIR(ir, stubMeasure);
    const texts = layout.ops.map((o) => o.text);
    expect(texts).toContain('Attention - passage 1');
    expect(texts.some((t) => t.includes('/doc/sec'))).toBe(false);
    expect(texts.some((t) => t.includes('dev-grounded-1'))).toBe(false);
    expect(texts.some((t) => t.startsWith('[1] Cited passage (thread 1)'))).toBe(true);
    // Per-thread citation labels live only in the consolidated index now.
    expect(texts.some((t) => t.startsWith('Citations:'))).toBe(false);
    // Evidence quotes are not duplicated anywhere: they render once, in place.
    expect(texts.some((t) => t.includes('Attention is the rarest'))).toBe(true);
  });

  it('never strands the divider nor leaves an empty page, whatever the article length', () => {
    // Sweeps filler lengths so the divider lands at every page phase,
    // including page tails (old code stranded the title on the next page)
    // and fresh page tops (an unconditional break would insert an empty one).
    for (let fill = 0; fill <= 40; fill += 1) {
      const filler = Array.from({ length: fill }, (_, i) => ({
        node_type: 'paragraph',
        depth: 2,
        structural_path: `/doc/sec[1]/p[${i + 1}]`,
        text: `Filler paragraph ${i + 1}.`,
      }));
      const ir = buildExportIR(input({ nodes: filler, threads: [thread()] }));
      const layout = layoutExportIR(ir, stubMeasure);
      const divider = layout.ops.find((o) => o.marker === 'appendix-divider')!;
      const firstTitle = layout.ops.find((o) => o.marker === 'thread-1')!;
      expect(firstTitle.page, `fill=${fill}`).toBe(divider.page);
      for (let p = 1; p <= layout.pages; p += 1) {
        expect(
          layout.ops.some((o) => o.page === p),
          `fill=${fill} page ${p} has no content`,
        ).toBe(true);
      }
    }
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
