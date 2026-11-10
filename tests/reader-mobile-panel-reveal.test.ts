import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NARROW_READER_MAX_WIDTH,
  isNarrowReader,
} from '../apps/web/lib/reader-viewport.js';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

/** Slice a top-level function/effect body: from marker to the next marker. */
function bodyBetween(s: string, startMarker: string, endMarker: string): string {
  const start = s.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = s.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

describe('reader viewport breakpoint', () => {
  it('matches the reader stylesheet breakpoint', () => {
    expect(NARROW_READER_MAX_WIDTH).toBe(900);
  });

  it('classifies phone/mobile widths as narrow and desktop as wide', () => {
    for (const w of [320, 360, 375, 390, 768, 900]) {
      expect(isNarrowReader(w), `width ${w}`).toBe(true);
    }
    for (const w of [901, 1024, 1280, 1440]) {
      expect(isNarrowReader(w), `width ${w}`).toBe(false);
    }
  });
});

describe('mobile thread-panel reveal: one in-flow target', () => {
  it('attaches the panel ref to the existing aside', () => {
    const s = src();
    expect(s).toMatch(/const asideRef = useRef<HTMLElement>\(null\)/);
    expect(s).toMatch(/<aside\s+ref=\{asideRef\}/);
    // The aside stays the same landmark with the same thread/highlights roles.
    expect(s).toMatch(/aria-label="Passage threads and highlights"/);
  });

  it('reveals the panel only on narrow viewports', () => {
    const s = src();
    const body = bodyBetween(s, 'const revealThreadPanel = useCallback', '}, []);');
    // No-ops on desktop, where the sticky panel is already visible.
    expect(body).toMatch(/if \(!isNarrowReader\(window\.innerWidth\)\) return;/);
    expect(body).toMatch(/asideRef\.current/);
    expect(body).toMatch(/el\.scrollIntoView/);
    expect(body).toMatch(/block: 'start'/);
    // In flow: no overlay, no transform, no timers.
    expect(body).not.toMatch(/position:/);
    expect(body).not.toMatch(/transform/);
    expect(body).not.toMatch(/setTimeout/);
  });

  it('scrolls the panel when an explanation starts', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    const busyIdx = body.indexOf('setBusy(true)');
    const revealIdx = body.indexOf('revealThreadPanel();');
    expect(busyIdx).toBeGreaterThanOrEqual(0);
    expect(revealIdx).toBeGreaterThan(busyIdx);
    // The loading card and the answer both live in that panel.
    expect(s).toMatch(/Preparing explanation/);
  });
});

describe('mobile thread-panel reveal: reopening an existing thread', () => {
  it('reveals the panel and does not scroll back to the passage on narrow viewports', () => {
    const s = src();
    const body = bodyBetween(s, 'async function openThread', 'async function explain()');
    expect(body).toMatch(/if \(isNarrowReader\(window\.innerWidth\)\) revealThreadPanel\(\);/);
    // The passage scroll is the desktop branch only — a mobile reopen must not
    // jump back to the passage after the panel was revealed.
    expect(body).toMatch(/else if \(contextPassageId\) scrollToPassage\(contextPassageId\)/);
    const revealIdx = body.indexOf('revealThreadPanel();');
    const passageIdx = body.indexOf('scrollToPassage(contextPassageId)');
    expect(revealIdx).toBeGreaterThanOrEqual(0);
    expect(passageIdx).toBeGreaterThan(revealIdx);
  });

  it('preserves the explicit return-to-passage control', () => {
    const s = src();
    expect(s).toMatch(/View passage in document/);
    expect(s).toMatch(/if \(activePassageId\) scrollToPassage\(activePassageId\)/);
  });
});

describe('mobile thread-panel reveal: completion does not yank the reader back', () => {
  it('keeps the one-shot target but skips the passage scroll on narrow viewports', () => {
    const s = src();
    const nav = bodyBetween(s, 'One-shot Explain navigation', 'Return keyboard focus');
    // Still consumed exactly once, after the authoritative thread renders.
    expect(nav).toMatch(/pendingExplainRef\.current = null/);
    expect(nav).toMatch(/if \(!threadScrollRef\.current\) return;/);
    // Narrow: no second scroll (the panel was revealed at request start).
    // Desktop: existing one-shot passage navigation.
    expect(nav).toMatch(/if \(!isNarrowReader\(window\.innerWidth\)\) scrollToPassage\(passageId, 'start'\)/);
    expect(nav).not.toMatch(/revealThreadPanel/);
    expect(nav).not.toMatch(/setTimeout/);
  });
});

describe('mobile thread-panel reveal: Explain chip does not cover the panel', () => {
  it('renders the popover only while the reader is idle', () => {
    const s = src();
    expect(s).toMatch(/\{pending && !busy \? \(/);
    expect(s).toMatch(/data-testid="explain-pop"/);
  });
});

describe('reduced motion', () => {
  it('uses an instant scroll when the OS asks for reduced motion', () => {
    const s = src();
    expect(s).toMatch(/\(prefers-reduced-motion: reduce\)/);
    expect(s).toMatch(/window\.matchMedia/);
    // Both programmatic scroll helpers keep a non-animated branch.
    const passage = bodyBetween(s, 'const scrollToPassage = useCallback', '}, [clearFlash]);');
    expect(passage).toMatch(/if \(prefersReducedMotion\(\)\) el\.scrollIntoView\(\{ block \}\);/);
    const panel = bodyBetween(s, 'const revealThreadPanel = useCallback', '}, []);');
    expect(panel).toMatch(/if \(prefersReducedMotion\(\)\) el\.scrollIntoView\(\{ block: 'start' \}\);/);
    // Exactly one scroll executes per invocation: the reduced-motion and
    // smooth branches are one mutually exclusive if/else, and no call sits
    // outside that pair (which would scroll twice).
    const pair = passage.match(
      /if \(prefersReducedMotion\(\)\) el\.scrollIntoView\(\{ block \}\);\s*else el\.scrollIntoView\(\{ behavior: 'smooth', block \}\);/,
    );
    expect(pair).not.toBeNull();
    expect([...passage.matchAll(/el\.scrollIntoView\(/g)]).toHaveLength(2);
    expect(passage.slice(0, passage.indexOf('if (prefersReducedMotion()'))).not.toMatch(/scrollIntoView/);
    // No unconditional call before the branch and no third call after it.
    const afterPair = passage.slice(
      passage.indexOf("behavior: 'smooth', block });") + "behavior: 'smooth', block });".length,
    );
    expect(afterPair).not.toMatch(/scrollIntoView/);
  });

  it('keeps the existing animated branch for normal motion', () => {
    const s = src();
    expect(s).toMatch(/el\.scrollIntoView\(\{ behavior: 'smooth', block \}\)/);
    expect(s).toMatch(/el\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  });
});

/** Extract every @media block for a query, brace-matched. */
function mediaBlocks(c: string, query: string): string[] {
  const blocks: string[] = [];
  let i = 0;
  while ((i = c.indexOf(query, i)) !== -1) {
    const open = c.indexOf('{', i);
    expect(open).toBeGreaterThan(i);
    let depth = 0;
    let j = open;
    for (; j < c.length; j += 1) {
      if (c[j] === '{') depth += 1;
      else if (c[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(c.slice(i, j + 1));
    i = j + 1;
  }
  return blocks;
}

describe('mobile thread-panel reveal: stylesheet stays in flow', () => {
  it('adds the scroll margin inside the existing narrow media query', () => {
    const c = css();
    const narrow = mediaBlocks(c, '@media (max-width: 900px)').find((b) => /\.side\s*\{/.test(b));
    expect(narrow).toBeDefined();
    const rule = narrow!.match(/\.side\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/scroll-margin-top:\s*12px/);
    expect(rule![1]).toMatch(/position:\s*static/);
    expect(rule![1]).toMatch(/max-height:\s*none/);
    expect(rule![1]).toMatch(/overflow:\s*visible/);
  });

  it('declares .side exactly once in that narrow media query', () => {
    const narrow = mediaBlocks(css(), '@media (max-width: 900px)')
      .find((b) => /\.side\s*\{/.test(b));
    expect(narrow).toBeDefined();
    // One rule, not a split base/override pair (which would let one silently
    // win over the other and drop the scroll margin).
    expect([...narrow!.matchAll(/\.side\s*\{/g)]).toHaveLength(1);
    const body = narrow!.match(/\.side\s*\{([^}]*)\}/)![1];
    for (const prop of ['position', 'max-height', 'overflow', 'scroll-margin-top']) {
      const count = [...body.matchAll(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:`, 'g'))].length;
      expect(count, `${prop} declared once`).toBe(1);
    }
    // The neighbouring thread-card sizing is untouched.
    expect(narrow!).toMatch(/\.thread-card\s*\{\s*max-height:\s*70vh;\s*\}/);
  });

  it('does not introduce an overlay or transform for the panel', () => {
    const c = css();
    for (const m of c.matchAll(/\.side\s*\{([^}]*)\}/g)) {
      expect(m[1]).not.toMatch(/position:\s*(absolute|fixed)/);
      expect(m[1]).not.toMatch(/transform\s*:/);
    }
    // Resize-handle contract remains untouched.
    expect(c).toMatch(/\.thread-resize\s*\{[^}]*flex:\s*0 0 auto/);
    expect(c).not.toMatch(/setTimeout/);
  });
});
