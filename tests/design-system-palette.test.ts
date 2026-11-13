import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stage 3 palette and component contracts. Values are asserted once here so a
 * later palette edit has to update the approved source in one place, while
 * the contrast checks keep the reading surfaces legible.
 */
const css = () => readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

/** Parse the semantic :root token block into name -> value. */
function tokens(source: string): Record<string, string> {
  const rootEnd = source.indexOf('\n}') + 2;
  const root = source.slice(0, rootEnd);
  const out: Record<string, string> = {};
  for (const match of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

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

function luminance(value: string): number {
  const raw = value.trim().replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x relative contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('design system palette: approved roles', () => {
  it('1. surfaces, text, accent, reading and status tokens match the approved palette', () => {
    const t = tokens(css());
    const approved: Record<string, string> = {
      '--paper': '#f7f5ef',
      '--surface': '#fffdf8',
      '--surface-hover': '#f4f1e8',
      '--surface-row-hover': '#eeece5',
      '--surface-pressed': '#eeece5',
      '--ink': '#25231f',
      '--ink-secondary': '#5b574e',
      '--ink-muted': '#6b6659',
      '--accent': '#365a46',
      '--accent-hover': '#2c4a39',
      '--accent-active': '#243d2f',
      '--focus': '#365a46',
      '--highlight': '#f2eacb',
      '--highlight-strong': '#eadfb8',
      '--danger': '#8a2f2a',
      '--success': '#2f6b4a',
      '--warning': '#8a5a00',
      '--info': '#2f5d8a',
    };

    for (const [name, value] of Object.entries(approved)) {
      expect(t[name], name).toBe(value);
    }

    // Stage 2's accessible control boundary is deliberately retained.
    expect(t['--border-control']).toBe('#857d6d');
    // Decorative dividers stay lighter than control boundaries.
    expect(t['--border']).toBe('#e3ded2');
    expect(contrast(t['--border'], t['--surface'])).toBeLessThan(2);
  });

  it('2. roles that share a value stay separate', () => {
    const t = tokens(css());
    // Primary action fill and accent text are different roles.
    expect(t['--action-primary']).toBe(t['--accent']);
    // Same for the darker press tone.
    expect(t['--accent-active']).toBe(t['--action-primary-active']);
    // Citation chip boundary is its own strong boundary, not the decorative border.
    expect(t['--border-chip']).not.toBe(t['--border']);
    expect(t['--border-chip']).not.toBe(t['--border-control']);
    // Focus stays its own role even though it matches the accent.
    expect(t['--focus']).toBe(t['--accent']);
  });
});

describe('design system palette: contrast', () => {
  it('3. reading text and status copy clear AA on the new surfaces', () => {
    const t = tokens(css());
    const surfaces = ['--paper', '--surface'];

    for (const surface of surfaces) {
      expect(contrast(t['--ink'], t[surface]), surface).toBeGreaterThanOrEqual(7);
      expect(contrast(t['--ink-secondary'], t[surface]), surface).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--ink-muted'], t[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }

    for (const surface of ['--surface-hover', '--surface-row-hover']) {
      expect(contrast(t['--ink-muted'], t[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }

    for (const status of ['--danger', '--success', '--warning', '--info']) {
      expect(contrast(t[status], t['--paper']), status).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('4. actions, citations and focus clear their required thresholds', () => {
    const t = tokens(css());
    expect(contrast(t['--on-inverse'], t['--action-primary'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--on-inverse'], t['--danger'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--accent'], t['--citation-surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--citation-text'], t['--citation-surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--focus'], t['--paper'])).toBeGreaterThanOrEqual(3);
    expect(contrast(t['--border-control'], t['--field-surface'])).toBeGreaterThanOrEqual(3);
    expect(contrast(t['--border-chip'], t['--surface'])).toBeGreaterThanOrEqual(3);
    expect(contrast(t['--border-chip'], t['--citation-surface'])).toBeGreaterThanOrEqual(3);
  });
});

describe('design system palette: components', () => {
  it('5. primary, secondary and destructive buttons use the action roles', () => {
    const source = css();
    const primary = declarations(source, '.btn {');
    expect(primary).toMatch(/background:\s*var\(--action-primary\)/);
    expect(primary).toMatch(/color:\s*var\(--on-inverse\)/);
    expect(primary).toMatch(/border-radius:\s*4px/);

    expect(declarations(source, '.btn:not(:disabled):hover {')).toMatch(
      /background:\s*var\(--action-primary-hover\)/,
    );
    expect(declarations(source, '.btn:not(:disabled):active {')).toMatch(
      /background:\s*var\(--action-primary-active\)/,
    );

    const secondary = declarations(source, '.btn-ghost {');
    expect(secondary).toMatch(/background:\s*var\(--surface\)/);
    expect(secondary).toMatch(/border:\s*1px solid var\(--border-control\)/);
    expect(secondary).toMatch(/border-radius:\s*4px/);

    expect(declarations(source, '.btn-danger {')).toMatch(/background:\s*var\(--danger\)/);
    expect(declarations(source, '.btn:disabled {')).toMatch(/cursor:\s*not-allowed/);

    // No decorative motion or gradients were introduced.
    expect(source).not.toMatch(/transform\s*:/);
    expect(source).not.toMatch(/linear-gradient|radial-gradient/);
  });

  it('6. inputs use the 40px normal and 36px search heights with control styling', () => {
    const source = css();
    for (const marker of ['.import-url {', '.auth-field input {']) {
      const rule = declarations(source, marker);
      expect(rule, marker).toMatch(/height:\s*40px/);
      expect(rule, marker).toMatch(/border:\s*1px solid var\(--border-control\)/);
      expect(rule, marker).toMatch(/border-radius:\s*4px/);
    }

    expect(declarations(source, '.library-search input {')).toMatch(/height:\s*36px/);
    // The in-thread composer stays compact so the Reader card geometry and its
    // measured resize floor are unchanged.
    expect(declarations(source, '.followup input {')).not.toMatch(/height:\s*40px/);
    expect(declarations(source, '.followup input {')).toMatch(/border-radius:\s*4px/);
    // The legacy Library specificity override keeps the same height.
    expect(declarations(source, '.library-page .import-row input.import-url {')).toMatch(
      /height:\s*40px/,
    );
  });

  it('7. citations use pale sage surfaces and pine text, not saturated teal', () => {
    const source = css();
    const block = declarations(source, '.cite-block {');
    expect(block).toMatch(/background:\s*var\(--citation-surface\)/);
    expect(block).toMatch(/border:\s*1px solid var\(--border-citation-soft\)/);
    expect(block).toMatch(/border-radius:\s*6px/);
    // The heavy 4px left rule is gone; citations are no longer cards-in-cards.
    expect(block).not.toMatch(/border-left/);

    const chip = declarations(source, '.cite-btn {');
    expect(chip).toMatch(/border:\s*1px solid var\(--border-chip\)/);
    expect(chip).toMatch(/border-radius:\s*4px/);
    expect(declarations(source, '.cite-btn:hover {')).toMatch(
      /background:\s*var\(--citation-surface\)/,
    );

    expect(declarations(source, 'mark.cite-flash {')).toMatch(
      /background:\s*var\(--citation-surface-strong\)/,
    );

    // The previous teal palette is fully removed.
    expect(source).not.toMatch(/#0f766e|#ccfbf1|#5eead4|#f0fdfa|#0b5e56/i);
  });

  it('8. reader surfaces, highlights and the expanded layout contract hold', () => {
    const source = css();
    for (const marker of ['.doc {', '.thread-card {', '.hl-list {']) {
      expect(declarations(source, marker), marker).toMatch(/background:\s*var\(--surface\)/);
    }

    expect(declarations(source, '.passage.active {')).toMatch(
      /background:\s*var\(--surface-passage-active\)/,
    );
    expect(declarations(source, 'mark.hl {')).toMatch(/background:\s*var\(--highlight\)/);
    expect(declarations(source, 'mark.hl:hover {')).toMatch(
      /background:\s*var\(--highlight-strong\)/,
    );
    expect(declarations(source, '.thread-card .sel {')).toMatch(/color:\s*var\(--ink-excerpt\)/);

    // Panel geometry and the mobile one-column behaviour are untouched.
    expect(source).toMatch(/clamp\(520px, 48vw, 720px\)/);
    expect(source).toMatch(
      /@media \(max-width: 900px\) \{\s*\.reader, \.reader-expanded \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );
  });

  it('9. cards use 6px and controls use 4px radii', () => {
    const source = css();
    for (const marker of ['.doc {', '.thread-card {', '.hl-list {', '.cite-block {']) {
      expect(declarations(source, marker), marker).toMatch(/border-radius:\s*6px/);
    }
    for (const marker of [
      '.btn {',
      '.btn-ghost {',
      '.cite-btn {',
      '.passage-thread-link {',
      '.followup input {',
      '.auth-field input {',
    ]) {
      expect(declarations(source, marker), marker).toMatch(/border-radius:\s*4px/);
    }
  });

  it('10. explain-pop drops the heavy shadow but keeps its dark chip', () => {
    const source = css();
    const pop = declarations(source, '.explain-pop {');
    expect(pop).toMatch(/background:\s*var\(--surface-inverse\)/);
    expect(pop).toMatch(/border-radius:\s*4px/);
    expect(pop).not.toMatch(/box-shadow/);
    expect(source).not.toMatch(/box-shadow:\s*0 4px 16px/);
  });
});
