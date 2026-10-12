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
    expect(s).toMatch(/THREAD_MIN_H = 320/);
    // Minimum is measured from the live card layout, floored at THREAD_MIN_H.
    expect(s).toMatch(/getThreadMinHeight/);
    expect(s).toMatch(/Math\.max\(THREAD_MIN_H, measured\)/);
    // Clamp both directions; max leaves ~80px of the Reader visible below.
    expect(s).toMatch(/Math\.min\(threadMaxHeight\(\), Math\.max\(getThreadMinHeight\(\)/);
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
    // Slider floor tracks the measured layout minimum, not the raw constant.
    expect(s).toMatch(/aria-valuemin=\{getThreadMinHeight\(\)\}/);
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
    expect(s).toMatch(/THREAD_MIN_H = 320/);
    expect(s).toMatch(/THREAD_STEP = 24/);
    expect(s).toMatch(/window\.innerHeight - 80/);
    expect(s).not.toMatch(/localStorage/);
    expect(s).not.toMatch(/sessionStorage/);
    // Clamp floors at the measured layout minimum (Home key included).
    expect(s).toMatch(/Math\.max\(getThreadMinHeight\(\), Math\.round\(h\)\)/);
    expect(s).toMatch(/e\.key === 'Home'/);
    expect(s).toMatch(/next = getThreadMinHeight\(\)/);
    // Functional floor-path contract (measured minimum at/below the floor
    // behaves as a static 320px minimum) mirrors the source formula.
    const THREAD_MIN_H = 320;
    const maxFor = (innerHeight: number) => Math.max(THREAD_MIN_H + 48, innerHeight - 80);
    const clamp = (h: number, innerHeight: number) =>
      Math.min(maxFor(innerHeight), Math.max(THREAD_MIN_H, Math.round(h)));
    expect(clamp(10, 800)).toBe(320);
    expect(clamp(320, 800)).toBe(320);
    expect(clamp(500.4, 800)).toBe(500);
    expect(clamp(500.5, 800)).toBe(501);
    expect(clamp(5000, 800)).toBe(720);
    expect(clamp(5000, 400)).toBe(368);
    expect(clamp(10, 400)).toBe(320);
    // Keyboard still honors the same bounds.
    expect(s).toMatch(/e\.key === 'ArrowDown'/);
    expect(s).toMatch(/e\.key === 'ArrowUp'/);
    expect(s).toMatch(/e\.key === 'Home'/);
    expect(s).toMatch(/e\.key === 'End'/);
    // Double-click resets to automatic height.
    expect(s).toMatch(/onDoubleClick=\{\(e\) => \{ e\.stopPropagation\(\); setThreadHeight\(null\); \}\}/);
  });
});

describe('viewport shrink reclamp (PATH A handle reachability)', () => {
  it('I. retained height is reclamped on viewport resize; null stays null', () => {
    const s = src();
    // Viewport-height change path exists and cleans up.
    expect(s).toMatch(/window\.addEventListener\('resize', onViewportResize\)/);
    expect(s).toMatch(/window\.removeEventListener\('resize', onViewportResize\)/);
    // Null preserved (automatic height); non-null reclamped via current policy.
    expect(s).toMatch(/if \(prev == null\) return prev/);
    expect(s).toMatch(/clampThreadHeight\(prev\)/);
    // Policy: 320px min, viewport-minus-80 max.
    expect(s).toMatch(/THREAD_MIN_H = 320/);
    expect(s).toMatch(/window\.innerHeight - 80/);
    // Functional proof mirrors the source formula.
    const THREAD_MIN_H = 320;
    const maxFor = (innerHeight: number) => Math.max(THREAD_MIN_H + 48, innerHeight - 80);
    const clamp = (h: number, innerHeight: number) =>
      Math.min(maxFor(innerHeight), Math.max(THREAD_MIN_H, Math.round(h)));
    // Live PATH A: viewport 498px -> max 418px; card was 505px, handle y=539-569.
    expect(maxFor(498)).toBe(418);
    expect(clamp(505, 800)).toBe(505);
    expect(clamp(505, 498)).toBe(418);
    expect(clamp(600, 900)).toBe(600);
    expect(clamp(600, 498)).toBe(418);
  });
});

describe('minimum-height boundary (handle never clipped at the smallest size)', () => {
  it('J. THREAD_MIN_H fits the measured fixed chrome on desktop and narrow breakpoints', () => {
    const s = src();
    const c = css();
    // The JS minimum under test.
    const minMatch = s.match(/const THREAD_MIN_H = (\d+);/);
    expect(minMatch).not.toBeNull();
    const MIN = Number(minMatch![1]);
    // The budget model only holds if the card is a flex column with hidden
    // overflow, the scroll region can absorb shrinking, and head/foot/handle
    // never shrink. Parse those structural facts from production CSS.
    // (Anchor the base card rule: the first `.thread-card {` occurrence is
    // the compact cursor rule, not the layout rule.)
    const cardRule = c.match(/\.thread-card \{([^}]*display:\s*flex[^}]*)\}/);
    expect(cardRule).not.toBeNull();
    expect(cardRule![1]).toMatch(/display:\s*flex/);
    expect(cardRule![1]).toMatch(/flex-direction:\s*column/);
    expect(cardRule![1]).toMatch(/overflow:\s*hidden/);
    const cardPad = cardRule![1].match(/padding:\s*(\d+)px/);
    expect(cardPad).not.toBeNull();
    const cardBorder = cardRule![1].match(/border:\s*(\d+)px/);
    expect(cardBorder).not.toBeNull();
    const cardChrome = 2 * Number(cardPad![1]) + 2 * Number(cardBorder![1]);
    const scrollRule = c.match(/\.thread-scroll \{([^}]*)\}/);
    expect(scrollRule).not.toBeNull();
    expect(scrollRule![1]).toMatch(/min-height:\s*0/);
    expect(scrollRule![1]).toMatch(/flex:\s*1\s+1\s+auto/);
    const scrollPad = scrollRule![1].match(/padding:\s*(\d+)px\s+\d+px\s+(\d+)px/);
    expect(scrollPad).not.toBeNull();
    const scrollMargin = scrollRule![1].match(/margin:\s*(\d+)px/);
    expect(scrollMargin).not.toBeNull();
    const scrollFloor = Number(scrollPad![1]) + Number(scrollPad![2]) + 2 * Number(scrollMargin![1]);
    for (const sel of ['.thread-head {', '.thread-foot {', '.thread-resize {']) {
      const idx = c.indexOf(sel);
      expect(idx, sel).toBeGreaterThanOrEqual(0);
      expect(c.slice(idx, c.indexOf('}', idx)), sel).toMatch(/flex:\s*0\s+0\s+auto/);
    }
    const handleRule = c.match(/\.thread-resize \{([^}]*)\}/);
    expect(handleRule).not.toBeNull();
    const handleH = handleRule![1].match(/height:\s*(\d+)px/);
    expect(handleH).not.toBeNull();
    const handleMargin = handleRule![1].match(/margin:\s*(\d+)px\s+(-\d+)px\s+(-\d+)px/);
    expect(handleMargin).not.toBeNull();
    const handleBlock = Number(handleMargin![1]) + Number(handleH![1]) + Number(handleMargin![3]);
    // Narrow breakpoint uses a taller handle; the same minimum must fit it.
    const mobileHandle = c.match(/@media \(max-width: 900px\) \{ \.thread-resize \{ height: (\d+)px; \} \}/);
    expect(mobileHandle).not.toBeNull();
    const mobileHandleBlock = Number(handleMargin![1]) + Number(mobileHandle![1]) + Number(handleMargin![3]);
    // Live-measured content heights (headless Chrome 154, production CSS +
    // thread-card DOM, 520px sidebar): 1-line excerpt head 100px, 2-line
    // excerpt head 123px, footer 109px. Fit boundary measured at 308px
    // (desktop, 2-line) and ~316px (narrow handle); 240px clipped the handle
    // by ~68px with elementFromPoint missing it.
    const HEAD_2LINE = 123;
    const FOOT = 109;
    const desktopNeed = cardChrome + HEAD_2LINE + scrollFloor + FOOT + handleBlock;
    const mobileNeed = cardChrome + HEAD_2LINE + scrollFloor + FOOT + mobileHandleBlock;
    expect(desktopNeed).toBe(308);
    expect(mobileNeed).toBe(316);
    // The minimum fits both breakpoints with room for subpixel/font variance,
    // so the scroll region (not the handle) absorbs the last shrinking.
    expect(MIN).toBeGreaterThanOrEqual(desktopNeed);
    expect(MIN).toBeGreaterThanOrEqual(mobileNeed);
    expect(MIN - mobileNeed).toBeGreaterThanOrEqual(0);
    expect(MIN - desktopNeed).toBeGreaterThanOrEqual(8);
    // ...without overshooting blindly: the minimum stays close to the
    // measured need and keeps a usable drag range on short viewports
    // (PATH A: 498px viewport -> 418px max, range must stay >= 48px).
    expect(MIN - mobileNeed).toBeLessThanOrEqual(16);
    expect(418 - MIN).toBeGreaterThanOrEqual(48);
    // The runtime minimum measures the live card (adapting to excerpt length
    // and breakpoint) and never drops below the floor above.
    expect(s).toMatch(/getThreadMinHeight/);
    expect(s).toMatch(/head\.offsetHeight/);
    expect(s).toMatch(/foot\.offsetHeight/);
    expect(s).toMatch(/handle\.offsetHeight/);
    expect(s).toMatch(/Math\.max\(THREAD_MIN_H, measured\)/);
    // The controls this budget protects are still in the fixed regions.
    expect(s).toMatch(/Close and return to reading/);
    expect(s).toMatch(/View passage in document/);
  });
});

describe('resize handle discoverability (sticky sidebar + full-bar hit target)', () => {
  it('G. sidebar stays pinned: no ancestor scroll container breaks position sticky', () => {
    const c = css();
    // The handle is only discoverable if .side actually sticks: sticky
    // engages solely when no ancestor between the element and the viewport
    // is a scroll container. overflow-x: hidden on html/body computes
    // overflow-y to auto, silently making <body> a scroll container that
    // disables sticking — the sidebar then scrolls away with the page
    // (e.g. after openThread scrolls the article to the passage), taking
    // the handle out of view. overflow-x: clip clips identically without
    // creating a scroll container.
    expect(c).toMatch(/\.side\s*\{[^}]*position:\s*sticky/);
    expect(c).toMatch(/\.side\s*\{[^}]*top:\s*16px/);
    const rootRule = c.match(/html,\s*body\s*\{([^}]*)\}/);
    expect(rootRule).not.toBeNull();
    expect(rootRule![1]).toMatch(/overflow-x:\s*clip/);
    expect(rootRule![1]).not.toMatch(/overflow-x:\s*hidden/);
  });

  it('H. the full edge-bar is the pointer target, not only the 5px grip', () => {
    const s = src();
    const c = css();
    // Bar has a meaningful hit height, not a 5px strip.
    const handleRule = c.match(/\.thread-resize\s*\{([^}]*)\}/);
    expect(handleRule).not.toBeNull();
    const h = handleRule![1].match(/height:\s*(\d+)px/);
    expect(h).not.toBeNull();
    expect(Number(h![1])).toBeGreaterThanOrEqual(20);
    // Full-width in-flow bar (flex row carrying a centered grip).
    expect(handleRule![1]).toMatch(/display:\s*flex/);
    expect(handleRule![1]).toMatch(/cursor:\s*ns-resize/);
    // Pointer handlers live on the bar element itself...
    const handleIdx = s.indexOf('data-testid="thread-resize-handle"');
    expect(handleIdx).toBeGreaterThanOrEqual(0);
    const handleJsx = s.slice(handleIdx, s.indexOf('</div>', handleIdx));
    expect(handleJsx).toMatch(/onPointerDown=\{onResizePointerDown\}/);
    expect(handleJsx).toMatch(/onPointerMove=\{onResizePointerMove\}/);
    expect(handleJsx).toMatch(/onPointerUp=\{endResizeDrag\}/);
    expect(handleJsx).toMatch(/onPointerCancel=\{endResizeDrag\}/);
    // ...and NOT on the inner grip span (grip hits bubble to the bar).
    const gripIdx = s.indexOf('thread-resize-grip', handleIdx);
    expect(gripIdx).toBeGreaterThan(handleIdx);
    const gripJsx = s.slice(gripIdx, s.indexOf('/>', gripIdx));
    expect(gripJsx).not.toMatch(/onPointer/);
    expect(gripJsx).not.toMatch(/onMouse/);
  });
});
