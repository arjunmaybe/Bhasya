import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NARROW_READER_MAX_WIDTH, isNarrowReader } from '../apps/web/lib/reader-viewport.js';

const css = () => readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

/** Body of the first rule whose selector is exactly `selector`. */
function ruleBody(c: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = c.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `missing rule ${selector}`).toBeTruthy();
  return m![1];
}

/** Contents of a media block, without its prelude and closing brace. */
function mediaBlock(c: string, prelude: string): string {
  const start = c.indexOf(prelude);
  expect(start, `missing media block ${prelude}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let bodyStart = -1;
  for (let i = c.indexOf('{', start); i < c.length; i++) {
    if (c[i] === '{') {
      depth++;
      if (depth === 1) bodyStart = i + 1;
    } else if (c[i] === '}') {
      depth--;
      if (depth === 0) return c.slice(bodyStart, i);
    }
  }
  throw new Error(`unbalanced media block ${prelude}`);
}

/** Numeric px value of a declaration such as `gap: 24px`. */
function px(body: string, prop: string): number {
  const m = body.match(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  expect(m, `missing ${prop} in ${body}`).toBeTruthy();
  return Number(m![1]);
}

interface Track {
  min: number;
  vw: number;
  max: number;
}

/** Column track for the thread panel, parsed from a grid declaration. */
function panelTrack(declarations: string, selector: string): Track {
  const rule = ruleBody(declarations, selector);
  const m = rule.match(
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*clamp\((\d+(?:\.\d+)?)px,\s*(\d+(?:\.\d+)?)vw,\s*(\d+(?:\.\d+)?)px\)/,
  );
  expect(m, `${selector} track changed shape`).toBeTruthy();
  return { min: Number(m![1]), vw: Number(m![2]), max: Number(m![3]) };
}

function at(track: Track, viewport: number): number {
  return Math.min(Math.max(track.min, (viewport * track.vw) / 100), track.max);
}

/**
 * Pseudo-geometry derived from the stylesheet: shell content box, document
 * track and the article measure inside `.doc` (border + 32px padding each
 * side). The expanded shell is capped at 1440px; the compact one at 1280px.
 */
function geometry(c: string) {
  const shell = ruleBody(c, '.shell');
  const desktop = mediaBlock(c, '@media (min-width: 901px)');
  const doc = ruleBody(c, '.doc');
  const inner = ruleBody(c, '.doc-inner');

  const shellMax = px(shell, 'max-width');
  const shellPad = px(shell, 'padding');
  const gap = px(ruleBody(c, '.reader'), 'gap');
  const docPad = px(doc, 'padding');
  const border = px(doc, 'border');

  const expandedShell = desktop.match(/\.shell:has\(\.reader-expanded\)\s*\{\s*max-width:\s*(\d+)px/);
  expect(expandedShell, 'expanded shell width missing').toBeTruthy();
  const expandedShellMax = Number(expandedShell![1]);

  const compact = panelTrack(c, '.reader');
  const expanded = panelTrack(desktop, '.reader-expanded');

  const content = (viewport: number, isExpanded: boolean) =>
    Math.min(isExpanded ? expandedShellMax : shellMax, viewport) - shellPad * 2;

  const panel = (viewport: number, isExpanded: boolean) =>
    at(isExpanded ? expanded : compact, viewport);

  const docTrack = (viewport: number, isExpanded: boolean) =>
    content(viewport, isExpanded) - gap - panel(viewport, isExpanded);

  const article = (viewport: number, isExpanded: boolean) =>
    docTrack(viewport, isExpanded) - border * 2 - docPad * 2;

  return {
    shellMax,
    expandedShellMax,
    gap,
    docPad,
    border,
    compact,
    expanded,
    inner,
    content,
    panel,
    docTrack,
    article,
  };
}

describe('desktop reader expansion: wider thread workspace', () => {
  it('1. compact state keeps the restrained 340px-400px sidebar track', () => {
    const g = geometry(css());
    expect(g.compact).toEqual({ min: 340, vw: 28, max: 400 });
    expect(g.shellMax).toBe(1280);
  });

  it('2. expanded state receives the wider 520px-720px desktop track', () => {
    const c = css();
    const desktop = mediaBlock(c, '@media (min-width: 901px)');
    // The wider track exists only in the desktop media query, and the compact
    // rule is not duplicated there.
    expect(desktop).toMatch(
      /\.reader-expanded\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*clamp\(520px,\s*48vw,\s*720px\)/,
    );
    expect(desktop).not.toMatch(/\.reader\s*\{\s*grid-template-columns/);
    const g = geometry(c);
    expect(g.expanded).toEqual({ min: 520, vw: 48, max: 720 });
  });

  it('3. shell expands to 1440px for the desktop reading workspace', () => {
    const c = css();
    const desktop = mediaBlock(c, '@media (min-width: 901px)');
    expect(desktop).toMatch(/\.shell:has\(\.reader-expanded\)\s*\{\s*max-width:\s*1440px/);
    expect(geometry(c).expandedShellMax).toBe(1440);
  });

  it('4. expanded panel is materially wider than compact at 1280px and 1440px', () => {
    const g = geometry(css());
    for (const viewport of [1280, 1440]) {
      const compact = g.panel(viewport, false);
      const expanded = g.panel(viewport, true);
      expect(expanded, `viewport ${viewport}`).toBeGreaterThan(compact * 1.5);
      expect(expanded - compact, `viewport ${viewport}`).toBeGreaterThanOrEqual(200);
    }
    // Pinned values: 48vw of 1280 is 614.4px; 48vw of 1440 is 691.2px.
    expect(g.panel(1280, true)).toBeCloseTo(614.4, 5);
    expect(g.panel(1440, true)).toBeCloseTo(691.2, 5);
    // The wider panel is paid for by the document track, as designed.
    expect(g.docTrack(1280, true)).toBeCloseTo(601.6, 5);
    expect(g.docTrack(1440, true)).toBeCloseTo(684.8, 5);
  });

  it('5. the article keeps its 34rem measure target when expanded', () => {
    const g = geometry(css());
    // The reading measure is capped by the design's 34rem (544px) column.
    expect(g.inner).toMatch(/max-width:\s*34rem/);
    // The expanded article track is narrower at 1280px (535.6px) and wider at
    // 1440px (618.8px), so the cap is what holds the sustained-read width.
    expect(g.docPad).toBe(32);
    expect(g.border).toBe(1);
    expect(g.article(1280, true)).toBeGreaterThanOrEqual(535);
    expect(g.article(1440, true)).toBeGreaterThanOrEqual(610);
    expect(g.article(1440, true)).toBeGreaterThan(g.article(1280, true));
  });

  it('6. document, gap and panel fit inside the shell in both states', () => {
    const g = geometry(css());
    for (const viewport of [901, 1024, 1280, 1366, 1440, 1600]) {
      for (const isExpanded of [false, true]) {
        const used = g.docTrack(viewport, isExpanded) + g.gap + g.panel(viewport, isExpanded);
        expect(used, `viewport ${viewport} expanded=${isExpanded}`).toBeLessThanOrEqual(
          g.content(viewport, isExpanded) + 1e-9,
        );
        expect(g.docTrack(viewport, isExpanded), `viewport ${viewport}`).toBeGreaterThan(0);
      }
    }
    // The expanded row fills the 1440px shell exactly at 1440px.
    expect(
      g.docTrack(1440, true) + g.gap + g.panel(1440, true),
    ).toBeCloseTo(g.content(1440, true), 5);
  });
});

describe('mobile reader layout remains single column', () => {
  it('7. narrow screens keep one column and the existing reveal breakpoint', () => {
    const c = css();
    const mobile = mediaBlock(c, '@media (max-width: 900px)');
    expect(mobile).toMatch(/\.reader,\s*\.reader-expanded\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}/);
    // No wide desktop track leaks into the narrow layout.
    expect(mobile).not.toMatch(/clamp\(520px/);
    expect(mobile).not.toMatch(/\.shell:has/);

    // The JS reveal breakpoint matches the stylesheet boundary, so the mobile
    // panel-reveal behaviour keeps applying at 900px and below only.
    expect(NARROW_READER_MAX_WIDTH).toBe(900);
    expect(isNarrowReader(900)).toBe(true);
    expect(isNarrowReader(901)).toBe(false);
  });
});
