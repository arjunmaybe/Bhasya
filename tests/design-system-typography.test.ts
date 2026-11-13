import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stage 4 reading-typography contracts. The measure and rhythm are asserted
 * against the stylesheet, and the empty-thread note is checked in the Reader
 * source so the old inline style cannot creep back in.
 */
const css = () => readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');
const reader = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');

/** Declarations of the first rule that starts a line with `marker`. */
function declarations(source: string, marker: string): string {
  const atLineStart = source.indexOf('\n' + marker);
  const start = atLineStart >= 0 ? atLineStart + 1 : source.startsWith(marker) ? 0 : -1;
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open, marker).toBeGreaterThan(start);
  const close = source.indexOf('}', open);
  expect(close, marker).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

describe('reading typography: measure and rhythm', () => {
  it('1. the reading column is capped at 34rem and stays centered', () => {
    const source = css();
    const inner = declarations(source, '.doc-inner {');
    expect(inner).toMatch(/max-width:\s*34rem/);
    expect(inner).toMatch(/margin:\s*0 auto/);
    expect(source).not.toMatch(/68ch/);
  });

  it('2. paragraphs keep 17px/1.75 and use one 10px bottom rhythm', () => {
    const source = css();
    const passage = declarations(source, '.passage {');
    expect(passage).toMatch(/font-size:\s*17px/);
    expect(passage).toMatch(/line-height:\s*1\.75/);
    expect(passage).toMatch(/margin:\s*0 0 10px/);

    const wrap = declarations(source, '.passage-wrap {');
    // The wrapper no longer adds a competing bottom margin or padding.
    expect(wrap).toMatch(/margin:\s*0;/);
    expect(wrap).not.toMatch(/margin-(top|right|bottom|left)/);
    expect(wrap).not.toMatch(/padding/);
  });

  it('3. document, Library and auth headings opt into pretty wrapping', () => {
    const source = css();
    for (const marker of [
      '.doc h1 {',
      '.doc h2 {',
      '.library-header h1 {',
      '.library-import-copy h2,',
      '.library-message h3 {',
      '.auth-header h1 {',
    ]) {
      expect(declarations(source, marker), marker).toMatch(/text-wrap:\s*pretty/);
    }
  });
});

describe('reading typography: empty thread note', () => {
  it('4. the note uses a CSS class with the same 14px size', () => {
    const source = css();
    const view = reader();
    expect(view).toMatch(/<p className="thread-empty">/);
    expect(view).not.toMatch(/style=\{\{\s*fontSize:\s*14\s*\}\}/);

    const rule = declarations(source, '.thread-empty {').trim();
    expect(rule).toBe('font-size: 14px;');
  });
});

describe('reading typography: preserved contracts', () => {
  it('5. palette and desktop panel geometry are untouched', () => {
    const source = css();
    expect(source).toMatch(/--paper:\s*#f7f5ef/);
    expect(source).toMatch(/--surface:\s*#fffdf8/);
    expect(source).toMatch(/--accent:\s*#365a46/);
    expect(source).toMatch(/--border-control:\s*#857d6d/);
    expect(source).toMatch(/clamp\(520px, 48vw, 720px\)/);
    expect(source).toMatch(/\.shell:has\(\.reader-expanded\)\s*\{\s*max-width:\s*1440px/);
    expect(declarations(source, '.thread-resize {')).toMatch(/height:\s*24px/);
  });

  it('6. clickable highlight visual styling is preserved', () => {
    const source = css();
    const mark = declarations(source, 'mark.hl {');
    expect(mark).toMatch(/background:\s*var\(--highlight\)/);
    expect(mark).toMatch(/cursor:\s*pointer/);
  });
});
