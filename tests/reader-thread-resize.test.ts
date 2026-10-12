import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

describe('passage thread manual resize (bottom-edge drag handle)', () => {
  it('1. open-thread card renders an accessible bottom-edge handle', () => {
    const s = src();
    expect(s).toMatch(/data-testid="thread-resize-handle"/);
    expect(s).toMatch(/role="slider"/);
    expect(s).toMatch(/aria-label="Resize passage thread height"/);
    expect(s).toMatch(/tabIndex=\{0\}/);
    expect(s).toMatch(/className="thread-resize"/);
  });

  it('2. height is local UI state with min/max clamp, reset on thread change', () => {
    const s = src();
    expect(s).toMatch(/useState<number \| null>\(null\)/);
    expect(s).toMatch(/THREAD_MIN_H = 240/);
    // Clamp both directions; max leaves ~80px of the Reader visible below.
    expect(s).toMatch(/Math\.min\(threadMaxHeight\(\), Math\.max\(THREAD_MIN_H/);
    expect(s).toMatch(/window\.innerHeight - 80/);
    // Sizes never leak across threads and are never persisted.
    expect(s).toMatch(/setThreadHeight\(null\);\s*\n?\s*\}, \[openThreadId\]\)/);
    expect(s).not.toMatch(/threadHeight.*localStorage|localStorage.*threadHeight/);
  });

  it('3. drag uses pointer capture and stays in normal flow', () => {
    const s = src();
    expect(s).toMatch(/onPointerDown=\{onResizePointerDown\}/);
    expect(s).toMatch(/onPointerMove=\{onResizePointerMove\}/);
    expect(s).toMatch(/onPointerUp=\{endResizeDrag\}/);
    expect(s).toMatch(/onPointerCancel=\{endResizeDrag\}/);
    expect(s).toMatch(/setPointerCapture\(e\.pointerId\)/);
    // Explicit height + non-growing flex keeps the card in flow so content
    // below shifts down; no overlay/absolute/transform positioning.
    expect(s).toMatch(/style=\{threadHeight != null \? \{ height: threadHeight, flex: '0 0 auto' \} : undefined\}/);
    const c = css();
    expect(c).toMatch(/\.thread-resize \{[^}]*cursor: ns-resize/);
    expect(c).toMatch(/\.thread-resize \{[^}]*touch-action: none/);
    const handleBlock = c.slice(c.indexOf('.thread-resize {'), c.indexOf('.thread-resize:focus-visible'));
    expect(handleBlock).not.toMatch(/position:\s*(absolute|fixed)/);
    expect(handleBlock).not.toMatch(/transform:/);
  });

  it('4. handle gestures never toggle the panel or break selection', () => {
    const s = src();
    // Clicks/drag on the handle must not reach the card compact-expand toggle.
    expect(s).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    // Double-click resets to automatic height.
    expect(s).toMatch(/onDoubleClick/);
    expect(s).toMatch(/setThreadHeight\(null\)/);
    // Selection elsewhere untouched: no select-all, no selection API in resize path.
    const body = s.slice(s.indexOf('onResizePointerDown'), s.indexOf('Compact reopen'));
    expect(body).not.toMatch(/getSelection|removeAllRanges|select\(\)/);
  });

  it('5. keyboard resizing covers arrows, Home, and End', () => {
    const s = src();
    expect(s).toMatch(/onKeyDown=\{onResizeKeyDown\}/);
    expect(s).toMatch(/e\.key === 'ArrowDown'/);
    expect(s).toMatch(/e\.key === 'ArrowUp'/);
    expect(s).toMatch(/e\.key === 'Home'/);
    expect(s).toMatch(/e\.key === 'End'/);
    expect(s).toMatch(/THREAD_STEP/);
    expect(s).toMatch(/aria-valuemin=\{THREAD_MIN_H\}/);
    expect(s).toMatch(/aria-valuenow=\{threadHeight/);
  });

  it('6. mobile keeps a usable drag target in normal flow', () => {
    const c = css();
    expect(c).toMatch(/@media \(max-width: 900px\) \{ \.thread-resize \{ height: 30px; \} \}/);
  });
});

describe('passage thread resize structural contract (in-flow, no overlay)', () => {
  it('A. thread card and Highlights are siblings in normal flow inside the same sidebar', () => {
    const s = src();
    const c = css();
    // Sidebar is a vertical flex column in normal flow.
    expect(c).toMatch(/\.side\s*\{[^}]*display:\s*flex/);
    expect(c).toMatch(/\.side\s*\{[^}]*flex-direction:\s*column/);
    // Both live inside the same <aside class="side">, thread first, Highlights after.
    const asideIdx = s.indexOf('<aside');
    expect(asideIdx).toBeGreaterThanOrEqual(0);
    const asideSlice = s.slice(asideIdx);
    expect(asideSlice).toMatch(/className=\{threadHeight != null \? 'side side-thread-resized' : 'side'\}/);
    expect(asideSlice).toMatch(/data-thread-resized=\{threadHeight != null \? 'true' : 'false'\}/);
    const cardIdx = s.indexOf('className="thread-card"', asideIdx);
    const hlIdx = s.indexOf('className="hl-list"', asideIdx);
    const asideCloseIdx = s.indexOf('</aside>', asideIdx);
    expect(cardIdx).toBeGreaterThan(asideIdx);
    expect(hlIdx).toBeGreaterThan(cardIdx);
    expect(asideCloseIdx).toBeGreaterThan(hlIdx);
    // Resizing sets a real layout height on the card (not a transform/overlay).
    expect(s).toMatch(/style=\{threadHeight != null \? \{ height: threadHeight, flex: '0 0 auto' \} : undefined\}/);
    expect(s).not.toMatch(/translateY/);
  });

  it('B. resized sidebar grows instead of clipping (Highlights pushed down, handle never clipped)', () => {
    const c = css();
    // Root cause of the bug: the default sidebar is viewport-constrained with
    // overflow hidden, so a growing thread squeezed .hl-list to zero and then
    // clipped the card bottom (handle). While resized, the sidebar must grow.
    expect(c).toMatch(/\.side\s*\{[^}]*max-height:\s*calc\(100vh/);
    expect(c).toMatch(/\.side\s*\{[^}]*overflow:\s*hidden/);
    const resizedSide = c.match(/\.side\[data-thread-resized="true"\]\s*\{([^}]*)\}/);
    expect(resizedSide).not.toBeNull();
    expect(resizedSide![1]).toMatch(/max-height:\s*none/);
    expect(resizedSide![1]).toMatch(/overflow:\s*visible/);
    // Explicit card height must not be clamped back to 100%/70vh while resized.
    expect(c).toMatch(/\.thread-card\[data-resized="true"\]\s*\{[^}]*max-height:\s*none/);
    // Highlights keeps its natural height and is pushed down, never squeezed away.
    expect(c).toMatch(/\.side\[data-thread-resized="true"\]\s*\.hl-list\s*\{[^}]*flex:\s*0 0 auto/);
    // The resized rules never hide Highlights.
    const hlResizedIdx = c.indexOf('.side[data-thread-resized="true"] .hl-list');
    expect(hlResizedIdx).toBeGreaterThanOrEqual(0);
    const hlResizedBlock = c.slice(hlResizedIdx, c.indexOf('}', hlResizedIdx));
    expect(hlResizedBlock).not.toMatch(/display:\s*none/);
    expect(hlResizedBlock).not.toMatch(/visibility:\s*hidden/);
    expect(hlResizedBlock).not.toMatch(/height:\s*0/);
  });

  it('C. no absolute/fixed positioning or transform movement for thread, Highlights, or handle', () => {
    const c = css();
    const forbidden = (blockName: string, block: string) => {
      expect(block, blockName).not.toMatch(/position:\s*absolute/);
      expect(block, blockName).not.toMatch(/position:\s*fixed/);
      expect(block, blockName).not.toMatch(/transform\s*:/);
      expect(block, blockName).not.toMatch(/translateY/);
    };
    // Base rules.
    for (const sel of ['.thread-card {', '.hl-list {', '.thread-resize {']) {
      const idx = c.indexOf(sel);
      expect(idx, sel).toBeGreaterThanOrEqual(0);
      forbidden(sel, c.slice(idx, c.indexOf('}', idx)));
    }
    // Resized-state overrides must not smuggle in an overlay either.
    for (const sel of [
      '.side[data-thread-resized="true"]',
      '.thread-card[data-resized="true"]',
    ]) {
      const idx = c.indexOf(sel);
      expect(idx, sel).toBeGreaterThanOrEqual(0);
      forbidden(sel, c.slice(idx, c.indexOf('}', idx) + 200));
    }
    // No JS coordinate movement of Highlights during resize.
    const s = src();
    const resizeBody = s.slice(s.indexOf('onResizePointerDown'), s.indexOf('Compact reopen'));
    expect(resizeBody).not.toMatch(/hl-list/);
    expect(resizeBody).not.toMatch(/translate/);
    expect(resizeBody).not.toMatch(/style\.top/);
    expect(s).not.toMatch(/position:\s*'(absolute|fixed)'/);
  });

  it('D. handle is the bottom in-flow child and always rendered while the thread is open', () => {
    const s = src();
    const c = css();
    const footIdx = s.indexOf('className="thread-foot"');
    const handleIdx = s.indexOf('data-testid="thread-resize-handle"');
    const hlIdx = s.indexOf('className="hl-list"');
    expect(footIdx).toBeGreaterThanOrEqual(0);
    expect(handleIdx).toBeGreaterThan(footIdx);
    // Handle comes before Highlights in source (last child of the card, card before hl-list).
    expect(handleIdx).toBeLessThan(hlIdx);
    // Handle lives inside the open-thread branch, not gated on any height value.
    const openBranchIdx = s.indexOf('{openThreadId ? (');
    const busyCardIdx = s.indexOf('data-testid="thread-loading-card"');
    expect(openBranchIdx).toBeGreaterThanOrEqual(0);
    expect(handleIdx).toBeGreaterThan(openBranchIdx);
    expect(handleIdx).toBeLessThan(busyCardIdx);
    expect(s).not.toMatch(/threadHeight\s*!=\s*null\s*&&[\s\S]{0,300}thread-resize-handle/);
    expect(s).not.toMatch(/threadHeight\s*===\s*null\s*\?[\s\S]{0,300}thread-resize-handle/);
    expect(s).not.toMatch(/threadHeight\s*\?\s*[\s\S]{0,300}thread-resize-handle/);
    // In-flow handle styling: participates in the card flex column, never overlaid.
    const handleCssIdx = c.indexOf('.thread-resize {');
    expect(handleCssIdx).toBeGreaterThanOrEqual(0);
    const handleCss = c.slice(handleCssIdx, c.indexOf('}', handleCssIdx));
    expect(handleCss).toMatch(/flex:\s*0 0 auto/);
    expect(handleCss).not.toMatch(/position:\s*(absolute|fixed|sticky)/);
  });

  it('E. overflow rules keep conversation scrolling without clipping Highlights', () => {
    const c = css();
    // Conversation keeps its own internal scroll region.
    expect(c).toMatch(/\.thread-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(c).toMatch(/\.thread-card\s*\{[^}]*overflow:\s*hidden/);
    // Highlights list keeps its own bounded scroll for long lists (not hidden).
    expect(c).toMatch(/\.hl-list\s*\{[^}]*overflow-y:\s*auto/);
    expect(c).toMatch(/\.hl-list\s*\{[^}]*max-height:\s*32vh/);
    // While resized, the outer sidebar no longer clips either of them.
    const resizedIdx = c.indexOf('.side[data-thread-resized="true"] {');
    expect(resizedIdx).toBeGreaterThanOrEqual(0);
    const resizedBlock = c.slice(resizedIdx, c.indexOf('}', resizedIdx));
    expect(resizedBlock).not.toMatch(/overflow:\s*hidden/);
    expect(resizedBlock).not.toMatch(/overflow:\s*auto/);
  });

  it('F. min/max clamping is correct and height is never persisted', () => {
    const s = src();
    expect(s).toMatch(/THREAD_MIN_H = 240/);
    expect(s).toMatch(/THREAD_STEP = 24/);
    expect(s).toMatch(/window\.innerHeight - 80/);
    expect(s).not.toMatch(/localStorage/);
    expect(s).not.toMatch(/sessionStorage/);
    // Functional clamp contract mirrors the source formula.
    const THREAD_MIN_H = 240;
    const maxFor = (innerHeight: number) => Math.max(THREAD_MIN_H + 48, innerHeight - 80);
    const clamp = (h: number, innerHeight: number) =>
      Math.min(maxFor(innerHeight), Math.max(THREAD_MIN_H, Math.round(h)));
    expect(clamp(10, 800)).toBe(240);
    expect(clamp(240, 800)).toBe(240);
    expect(clamp(500.4, 800)).toBe(500);
    expect(clamp(500.5, 800)).toBe(501);
    expect(clamp(5000, 800)).toBe(720);
    expect(clamp(5000, 400)).toBe(320);
    expect(clamp(10, 400)).toBe(240);
    // Keyboard still honors the same bounds.
    expect(s).toMatch(/e\.key === 'ArrowDown'/);
    expect(s).toMatch(/e\.key === 'ArrowUp'/);
    expect(s).toMatch(/e\.key === 'Home'/);
    expect(s).toMatch(/e\.key === 'End'/);
    // Double-click resets to automatic height.
    expect(s).toMatch(/onDoubleClick=\{\(e\) => \{ e\.stopPropagation\(\); setThreadHeight\(null\); \}\}/);
  });
});
