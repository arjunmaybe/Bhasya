import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stage 5 keyboard contracts for persisted passage highlights. There is no DOM
 * environment in this repository, so these assertions pin the exact Reader
 * markup, handler behaviour and focus rule that ship to the browser.
 */
const reader = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const css = () => readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

function bodyBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `${startMarker} -> ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Declarations of the first rule whose selector starts with `marker`. */
function declarations(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open, marker).toBeGreaterThan(start);
  const close = source.indexOf('}', open);
  expect(close, marker).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

const markBranch = (source: string) =>
  bodyBetween(source, 'if (s.marked) return', 'return <Fragment');

const flashBranch = (source: string) =>
  bodyBetween(source, 'if (s.flash) return', 'if (s.marked) return');

describe('persisted highlights: button semantics', () => {
  it('1. only persisted marks become keyboard buttons', () => {
    const source = reader();
    const mark = markBranch(source);

    expect(mark).toMatch(/className="hl"/);
    expect(mark).toMatch(/data-hl="1"/);
    expect(mark).toMatch(/role="button"/);
    expect(mark).toMatch(/tabIndex=\{0\}/);
    expect(mark).toMatch(/onKeyDown=\{onHighlightKeyDown\}/);
    expect(mark).toMatch(/onKeyUp=\{onHighlightKeyUp\}/);
    // The mark must keep relying on the paragraph's delegated click handler.
    expect(mark).not.toMatch(/\bonClick=/);

    const flash = flashBranch(source);
    expect(flash).not.toMatch(/role=/);
    expect(flash).not.toMatch(/tabIndex/);
    expect(flash).not.toMatch(/onKeyDown|onKeyUp/);
  });

  it('2. the highlighted text itself supplies the accessible name', () => {
    const mark = markBranch(reader());
    expect(mark).toMatch(/>\{slice\}<\/mark>/);
    // No redundant or overridden accessible name, and nothing hidden from AT.
    expect(mark).not.toMatch(/aria-label/);
    expect(mark).not.toMatch(/aria-hidden/);
  });
});

describe('persisted highlights: native-like keyboard activation', () => {
  it('3. Enter prevents default and activates once on keydown', () => {
    const source = reader();
    const down = bodyBetween(source, 'function onHighlightKeyDown', 'function onHighlightKeyUp');

    expect(down).toMatch(/if \(e\.key === 'Enter'\)/);
    expect(down).toMatch(/e\.preventDefault\(\)/);
    expect(down).toMatch(/if \(e\.repeat\) return/);
    expect(down).toMatch(/e\.currentTarget\.click\(\)/);
  });

  it('4. Space prevents scrolling on keydown and activates on keyup', () => {
    const source = reader();
    const down = bodyBetween(source, 'function onHighlightKeyDown', 'function onHighlightKeyUp');
    const up = bodyBetween(source, 'function onHighlightKeyUp', 'function MarkedPassageText');

    const spaceDownAt = down.indexOf("else if (e.key === ' ')");
    expect(spaceDownAt).toBeGreaterThanOrEqual(0);
    const spaceDown = down.slice(spaceDownAt);
    expect(spaceDown).toMatch(/e\.preventDefault\(\)/);
    expect(spaceDown).not.toMatch(/\.click\(\)/);

    expect(up).toMatch(/if \(e\.key === ' '\)/);
    expect(up).toMatch(/e\.currentTarget\.click\(\)/);
    expect(up).not.toMatch(/Enter/);
  });
});

describe('persisted highlights: focus and preserved behaviour', () => {
  it('5. keyboard focus uses the shared focus token without restyling the mark', () => {
    const source = css();
    const base = declarations(source, 'mark.hl {');
    expect(base).toMatch(/background:\s*var\(--highlight\)/);
    expect(base).toMatch(/border-radius:\s*4px/);
    expect(base).toMatch(/padding:\s*0 1px/);
    expect(base).toMatch(/cursor:\s*pointer/);

    const focus = declarations(source, 'mark.hl:focus-visible {');
    expect(focus).toMatch(/outline:\s*2px solid var\(--focus\)/);
    expect(focus).toMatch(/outline-offset:\s*2px/);
    expect(focus).not.toMatch(/background|border|box-shadow|color:/);
  });

  it('6. activation reuses the delegated passage handler unchanged', () => {
    const source = reader();
    const passage = bodyBetween(
      source,
      'function handlePassageClick',
      '// Id of the newest user question',
    );
    expect(passage).toMatch(/closest\?\.\('mark\.hl'\)/);
    expect(passage).toMatch(/hlByPassage\.get\(passageId\)/);
    expect(passage).toMatch(/openThread\(match\.thread_id, match\.selected_text\)/);
    expect(passage).toMatch(/scrollToPassage\(match\.passage_id\)/);

    const article = bodyBetween(source, 'const handleArticleClick', '// Manual thread-card resize');
    expect(article).toMatch(/closest\?\.\('mark\.hl,/);
  });

  it('7. citation flashes stay non-interactive', () => {
    const source = reader();
    const flash = flashBranch(source);
    expect(flash).toContain('className="cite-flash"');
    expect(flash).toContain('data-cite-flash="1"');
    expect(flash).not.toMatch(/role=|tabIndex|onKeyDown|onKeyUp|aria-label/);

    const styles = css();
    expect(declarations(styles, 'mark.cite-flash {')).not.toMatch(/cursor:/);
    expect(styles).not.toMatch(/mark\.cite-flash:focus/);
  });
});

describe('persisted highlights: single rendering branch', () => {
  it('8. exactly one marked branch exists and it is not the old bare mark', () => {
    const source = reader();
    const branches = source.match(/if \(s\.marked\) return/g) ?? [];
    expect(branches).toHaveLength(1);

    // The surviving branch must be the accessible multiline implementation.
    const at = source.indexOf('if (s.marked) return');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(source.slice(at, at + 'if (s.marked) return ('.length)).toBe(
      'if (s.marked) return (',
    );

    // The obsolete one-line branch must not remain before or after it.
    expect(source).not.toContain(
      'if (s.marked) return <mark key={i} className="hl" data-hl="1">{slice}</mark>;',
    );
    expect(source).not.toMatch(
      /if \(s\.marked\) return <mark[^>]*className="hl"[^>]*data-hl="1"[^>]*>\{slice\}<\/mark>/,
    );
  });
});
