import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');
const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');

/** CSS with all @media blocks stripped = desktop base rules. */
function desktopCss(c: string): string {
  let out = '';
  let i = 0;
  while (i < c.length) {
    const at = c.indexOf('@media', i);
    if (at === -1) {
      out += c.slice(i);
      break;
    }
    out += c.slice(i, at);
    const open = c.indexOf('{', at);
    expect(open).toBeGreaterThan(at);
    let depth = 0;
    let j = open;
    for (; j < c.length; j += 1) {
      if (c[j] === '{') depth += 1;
      else if (c[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

/** Full text of the narrow-viewport media block(s). */
function mobileCss(c: string): string {
  const start = c.indexOf('@media (max-width: 900px)');
  expect(start).toBeGreaterThanOrEqual(0);
  return c.slice(start);
}

describe('mobile-expanded excerpt: header stays compact, thread stays readable', () => {
  it('1. desktop .sel remains plain flow content (non-scrolling)', () => {
    const d = desktopCss(css());
    expect(d).toMatch(/\.reader-expanded \.thread-card \.sel/);
    expect(d).not.toMatch(/\.sel\s*\{[^}]*overflow-y/);
    expect(d).not.toMatch(/\.sel\s*\{[^}]*max-height/);
    expect(d).not.toMatch(/line-clamp/);
  });

  it('2. mobile-expanded .sel gets a scoped line-based cap with internal scroll', () => {
    const m = mobileCss(css());
    const rule = m.match(/\.reader-expanded \.thread-card \.sel\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1];
    // Typography-relative cap (~4 lines at the expanded 1.7 line-height),
    // never an arbitrary pixel height.
    expect(body).toMatch(/max-height:\s*6\.8em/);
    expect(body).not.toMatch(/\d+px/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    // Secondary context scrolls without chaining into the page/thread.
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    // Verbatim excerpt preserved: no ellipsis, clamp, or hidden text.
    expect(body).not.toMatch(/ellipsis/);
    expect(body).not.toMatch(/line-clamp/);
    expect(body).not.toMatch(/overflow:\s*hidden/);
    expect(body).not.toMatch(/white-space:\s*nowrap/);
  });

  it('3. mobile-expanded thread keeps its sizing; scroll region retains flex space', () => {
    const c = css();
    const m = mobileCss(c);
    // 82vh card sizing untouched.
    expect(m).toMatch(/\.reader-expanded \.thread-card\s*\{\s*max-height:\s*82vh/);
    // Conversation region still the flexible scroller.
    expect(c).toMatch(/\.thread-scroll\s*\{[^}]*flex:\s*1 1 auto/);
    expect(c).toMatch(/\.thread-scroll\s*\{[^}]*min-height:\s*0/);
    expect(c).toMatch(/\.thread-scroll\s*\{[^}]*overflow-y:\s*auto/);
    // Header stays flex-none; the fix caps excerpt content, not head flex.
    expect(c).toMatch(/\.thread-head\s*\{[^}]*flex:\s*0 0 auto/);
    // Highlights untouched: still capped and independently scrollable.
    expect(c).toMatch(/\.hl-list\s*\{[^}]*max-height:\s*32vh/);
    expect(c).toMatch(/\.hl-list\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('4. compact behavior unchanged (mobile and desktop)', () => {
    const c = css();
    const m = mobileCss(c);
    // Scoped rule never mentions compact: compact excerpt is untouched.
    expect(m).not.toMatch(/compact[^\n]*\.sel\s*\{[^}]*overflow-y/);
    expect(c).not.toMatch(/data-panel="compact"[^\n]*\.sel/);
    expect(c).toMatch(/\.reader\[data-panel="compact"\] \.thread-card\s*\{\s*cursor:\s*pointer/);
    // Excerpt still renders verbatim (full slice, no truncation in JS).
    expect(src()).toMatch(/threadSel\.slice\(0, 280\)/);
  });

  it('5. Explain auto-navigation behavior unchanged (no JS/layout coupling)', () => {
    const s = src();
    // One-shot Explain target still armed from the authoritative passage…
    expect(s).toMatch(/pendingExplainRef\.current = explainPassageId/);
    // …consumed once via the existing passage helper (no timers)…
    expect(s).toMatch(/scrollToPassage\(passageId, 'start'\)/);
    expect(s).toMatch(/el\.scrollIntoView\(\{ behavior: 'smooth', block \}\)/);
    // …and cleared on abort/failure/close so no stale target navigates.
    expect(s).toMatch(/pendingExplainRef\.current = null/);
    // No JS height measuring, inline style heights, timers, or second
    // navigation system introduced by the CSS-only fix.
    expect(s).not.toMatch(/\.style\.height/);
    expect(s).not.toMatch(/clientHeight.*pendingExplain/);
    const c = css();
    expect(c).not.toMatch(/setTimeout/);
  });
});
