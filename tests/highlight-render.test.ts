import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMarkedSegments,
  findHighlightRanges,
  findSelectionRange,
} from '../apps/web/lib/highlight-render.js';

/**
 * Highlight rendering contract (no DOM framework needed — these are the exact
 * pure functions ReaderClient renders from):
 * - persisted { passage_id: P, selected_text: S } marks S inside P's text
 * - every highlight in a passage renders (not just the first)
 * - a highlight is never offered to another passage (lookup is passage-keyed)
 * - brittle selections (whitespace) still resolve; misses never mark the
 *   whole paragraph.
 */
describe('highlight rendering contract', () => {
  const textA = 'Attention is the rarest and purest form of generosity. To attend fully to a passage is to give it time.';
  const textB = 'Memory keeps what attention touches. Readers who annotate remember more than readers who skim.';

  it('marks the exact persisted selection inside its own passage', () => {
    const sel = 'rarest and purest form of generosity';
    const r = findSelectionRange(textA, sel);
    expect(r).not.toBeNull();
    expect(textA.slice(r!.start, r!.end)).toBe(sel);
  });

  it('renders EVERY highlight in a passage, not just the first', () => {
    const ranges = findHighlightRanges(textA, [
      'rarest and purest form of generosity',
      'To attend fully to a passage',
    ]);
    expect(ranges.length).toBe(2);
    const covered = ranges.map((r) => textA.slice(r.start, r.end)).sort();
    expect(covered).toEqual(
      ['To attend fully to a passage', 'rarest and purest form of generosity'].sort(),
    );
  });

  it('does not offer passage A highlights to passage B (passage-keyed lookup)', () => {
    // Structural contract in the reader: highlights are grouped by passage_id
    // and each passage renders only its own selections.
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    expect(src).toMatch(/hlByPassage\.get\(p\.id\)/);
    expect(src).toMatch(/selections=\{hls\.map\(\(h\) => h\.selected_text\)\}/);
    // And the pure layer: B's text matched only against B's selections.
    const rangesInB = findHighlightRanges(textB, ['Memory keeps what attention touches']);
    expect(rangesInB.length).toBe(1);
    expect(textB.slice(rangesInB[0].start, rangesInB[0].end)).toBe('Memory keeps what attention touches');
    // A's selection is not a substring of B, so it marks nothing there.
    expect(findSelectionRange(textB, 'rarest and purest form of generosity')).toBeNull();
  });

  it('tolerates browser whitespace differences and reports original offsets', () => {
    const browserSel = 'purest form\nof  generosity. To attend';
    const r = findSelectionRange(textA, browserSel);
    expect(r).not.toBeNull();
    expect(textA.slice(r!.start, r!.end)).toBe('purest form of generosity. To attend');
  });

  it('never marks the whole paragraph on a miss', () => {
    expect(findHighlightRanges(textA, ['no such sentence here'])).toEqual([]);
    expect(findSelectionRange(textA, '')).toBeNull();
    expect(findSelectionRange(textA, null)).toBeNull();
    expect(findSelectionRange('', 'something')).toBeNull();
  });

  it('collapses overlapping selections deterministically', () => {
    const ranges = findHighlightRanges(textA, ['rarest and purest', 'rarest and purest form of generosity']);
    expect(ranges.length).toBe(1);
    expect(textA.slice(ranges[0].start, ranges[0].end)).toBe('rarest and purest form of generosity');
  });

  it('composes the transient citation flash distinctly from persistent marks', () => {
    const hls = findHighlightRanges(textA, ['rarest and purest form of generosity']);
    const flash = findSelectionRange(textA, 'To attend fully');
    expect(flash).not.toBeNull();
    const segs = buildMarkedSegments(textA, hls, flash);
    const flashed = segs.filter((s) => s.flash);
    const marked = segs.filter((s) => s.marked && !s.flash);
    expect(flashed.length).toBeGreaterThan(0);
    expect(flashed.map((s) => textA.slice(s.start, s.end)).join('')).toBe('To attend fully');
    expect(marked.map((s) => textA.slice(s.start, s.end)).join('')).toBe('rarest and purest form of generosity');
    // Full coverage, no gaps or overlaps: segments tile the text exactly.
    const tiled = segs.map((s) => textA.slice(s.start, s.end)).join('');
    expect(tiled).toBe(textA);
  });

  it('reader wires citation flash from the citation anchor (no screen coords)', () => {
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    expect(src).toMatch(/data-cite-flash="1"/);
    expect(src).toMatch(/cite-flash/);
    expect(src).toMatch(/h\.anchor_id === anchorId/);
    expect(src).toMatch(/findSelectionRange\(passageText, selText\)/);
  });
});
