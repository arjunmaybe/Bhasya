import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Accessibility contracts for the design system. These are source-level
 * checks: the stylesheet stays the single source of truth, and the numeric
 * contrast assertions read the same token values the browser receives.
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

describe('design system accessibility: control boundaries', () => {
  it('1. every control boundary clears 3:1 against the surfaces it sits on', () => {
    const source = css();
    const t = tokens(source);
    expect(t['--border-control']).toBeDefined();

    for (const surface of ['--field-surface', '--surface', '--paper', '--surface-row-hover']) {
      expect(contrast(t['--border-control'], t[surface]), surface).toBeGreaterThanOrEqual(3);
    }

    // Decorative rules keep their lighter value.
    expect(t['--border']).toBe('#e3ded2');
    // The resize grip is its own role, not a control boundary.
    expect(t['--resize-grip']).toBe('#c6c0b2');
    expect(t['--resize-grip']).not.toBe(t['--border-control']);
  });

  it('2. form controls consume the semantic control-boundary token', () => {
    const source = css();
    for (const marker of [
      '.import-url {',
      '.library-search input {',
      '.auth-field input {',
      '.followup input {',
      '.btn-ghost {',
      '.passage-thread-link {',
      '.library-search-button,',
    ]) {
      expect(declarations(source, marker), marker).toMatch(/border:\s*1px solid var\(--border-control\)/);
    }
  });
});

describe('design system accessibility: text contrast', () => {
  it('3. placeholder text clears 4.5:1 and uses the muted ink token', () => {
    const source = css();
    const t = tokens(source);
    const placeholder = source.slice(
      source.indexOf('.import-url::placeholder'),
      source.indexOf('}', source.indexOf('.import-url::placeholder')) + 1,
    );

    expect(placeholder).toContain('.library-search input::placeholder');
    expect(placeholder).toContain('.followup input::placeholder');
    expect(placeholder).toMatch(/color:\s*var\(--ink-muted\)/);
    expect(placeholder).toMatch(/opacity:\s*1/);
    expect(placeholder).not.toMatch(/--ink-faint/);

    for (const surface of ['--field-surface', '--surface', '--paper']) {
      expect(contrast(t['--ink-muted'], t[surface]), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('4. source metadata is at least 12px and clears 4.5:1', () => {
    const source = css();
    const t = tokens(source);
    expect(contrast(t['--ink-muted'], t['--paper'])).toBeGreaterThanOrEqual(4.5);
    // Hovered rows lighten the surface, so metadata must pass there too.
    expect(contrast(t['--ink-muted'], t['--surface-row-hover'])).toBeGreaterThanOrEqual(4.5);

    for (const marker of ['.source-index {', '.source-url {']) {
      const rule = declarations(source, marker);
      expect(rule, marker).toMatch(/color:\s*var\(--ink-muted\)/);
      const size = rule.match(/font-size:\s*(\d+)px/);
      expect(size, marker).not.toBeNull();
      expect(Number(size![1]), marker).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('design system accessibility: keyboard focus', () => {
  it('5. all focus indicators use the shared focus token', () => {
    const source = css();
    const global = declarations(source, 'button:focus-visible');
    expect(global).toMatch(/outline:\s*2px solid var\(--focus\)/);
    expect(global).toMatch(/outline-offset:\s*2px/);

    for (const marker of [
      '.auth-field input:focus-visible',
      '.thread-scroll:focus',
      '.thread-resize:focus-visible',
    ]) {
      const rule = declarations(source, marker);
      expect(rule, marker).toMatch(/outline:\s*2px solid var\(--focus\)/);
      // No component reintroduces its own focus colour.
      expect(rule, marker).not.toMatch(/#[0-9a-f]{3,8}/i);
    }

    // No focus ring anywhere is painted with a raw colour literal.
    expect(source).not.toMatch(/outline:\s*2px solid #/i);
  });
});

describe('design system accessibility: reduced motion', () => {
  it('6. flash and citeflash fall back to a static highlight and accent outline', () => {
    const source = css();
    const start = source.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf('\n}', start) + 2);

    expect(block).toContain('.passage.flash');
    expect(block).toContain('mark.cite-flash');
    expect(block).toMatch(/animation:\s*none/);
    expect(block).toMatch(/background:\s*var\(--highlight\)/);
    expect(block).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });

  it('7. the motion path is preserved for users who allow animation', () => {
    const source = css();
    expect(source).toMatch(/\.passage\.flash \{ animation: flash 1\.6s ease; \}/);
    expect(source).toMatch(/mark\.cite-flash \{[^}]*animation: citeflash 2\.6s ease/);
    expect(source).toContain('@keyframes flash');
    expect(source).toContain('@keyframes citeflash');
  });
});

describe('design system accessibility: disabled states', () => {
  it('8. disabled controls use the not-allowed cursor, never a busy cursor', () => {
    const source = css();
    for (const marker of ['.btn:disabled', '.import-url:disabled', '.explain-pop:disabled']) {
      expect(declarations(source, marker), marker).toMatch(/cursor:\s*not-allowed/);
    }
    expect(source).not.toMatch(/cursor:\s*wait/);
  });

  it('9. busy feedback itself is untouched', () => {
    const source = css();
    expect(declarations(source, '.btn:disabled')).toMatch(/opacity:\s*0\.5/);
    expect(declarations(source, '.explain-pop:disabled')).toMatch(/opacity:\s*0\.75/);
    expect(declarations(source, '.btn-ghost:disabled')).toMatch(/cursor:\s*default/);
  });
});

describe('design system accessibility: resize target', () => {
  it('10. the desktop resize bar is at least 24px tall and stays in flow', () => {
    const source = css();
    const handle = declarations(source, '.thread-resize {');
    const height = handle.match(/height:\s*(\d+)px/);
    expect(height).not.toBeNull();
    expect(Number(height![1])).toBeGreaterThanOrEqual(24);

    expect(handle).toMatch(/flex:\s*0 0 auto/);
    expect(handle).toMatch(/cursor:\s*ns-resize/);
    expect(handle).toMatch(/touch-action:\s*none/);
    expect(handle).not.toMatch(/position:\s*(absolute|fixed)/);
    expect(handle).not.toMatch(/transform/);
  });

  it('11. the mobile target and behaviour are unchanged', () => {
    const source = css();
    const mobile = source.match(
      /@media \(max-width: 900px\) \{ \.thread-resize \{ height: (\d+)px; \} \}/,
    );
    expect(mobile).not.toBeNull();
    expect(Number(mobile![1])).toBeGreaterThanOrEqual(24);
    // Only the height changes at the breakpoint; the handle stays the same
    // in-flow, full-width drag bar.
    expect(source).not.toMatch(
      /@media \(max-width: 900px\) \{ \.thread-resize \{[^}]*position:/,
    );
  });
});
