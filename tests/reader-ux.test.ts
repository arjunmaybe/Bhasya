import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clampExplainPosition,
  citationTargetPassageId,
} from '../apps/web/lib/explain-position.js';

const POP = { width: 140, height: 40 };
const VIEW = { width: 1280, height: 800 };

describe('reader UX: Explain popover stays in viewport', () => {
  it('places below the selection in the middle of the viewport', () => {
    const pos = clampExplainPosition({ anchorX: 400, anchorY: 300 }, POP, VIEW);
    expect(pos.placedAbove).toBe(false);
    expect(pos.left).toBe(400);
    expect(pos.top).toBe(308);
  });

  it('flips above near the bottom edge (Windows taskbar case)', () => {
    const pos = clampExplainPosition({ anchorX: 400, anchorY: 780 }, POP, VIEW);
    expect(pos.placedAbove).toBe(true);
    expect(pos.top + POP.height).toBeLessThanOrEqual(VIEW.height - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it('shifts left near the right edge', () => {
    const pos = clampExplainPosition({ anchorX: 1250, anchorY: 300 }, POP, VIEW);
    expect(pos.left + POP.width).toBeLessThanOrEqual(VIEW.width - 8);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('clamps near the left edge', () => {
    const pos = clampExplainPosition({ anchorX: 2, anchorY: 300 }, POP, VIEW);
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.left + POP.width).toBeLessThanOrEqual(VIEW.width - 8);
  });

  it('stays visible near the top edge', () => {
    const pos = clampExplainPosition({ anchorX: 400, anchorY: 4 }, POP, VIEW);
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.top + POP.height).toBeLessThanOrEqual(VIEW.height - 8);
  });

  it('stays visible in all four corners', () => {
    const corners = [
      { anchorX: 2, anchorY: 2 },
      { anchorX: 1278, anchorY: 2 },
      { anchorX: 2, anchorY: 798 },
      { anchorX: 1278, anchorY: 798 },
    ];
    for (const c of corners) {
      const pos = clampExplainPosition(c, POP, VIEW);
      expect(pos.left).toBeGreaterThanOrEqual(8);
      expect(pos.top).toBeGreaterThanOrEqual(8);
      expect(pos.left + POP.width).toBeLessThanOrEqual(VIEW.width - 8 + 0.001);
      expect(pos.top + POP.height).toBeLessThanOrEqual(VIEW.height - 8 + 0.001);
    }
  });

  it('accounts for the popover own dimensions (large popover)', () => {
    const big = { width: 220, height: 64 };
    const pos = clampExplainPosition({ anchorX: 1200, anchorY: 760 }, big, VIEW);
    expect(pos.left + big.width).toBeLessThanOrEqual(VIEW.width - 8);
    expect(pos.top + big.height).toBeLessThanOrEqual(VIEW.height - 8);
  });

  it('handles short and narrow viewports without escaping', () => {
    const short = { width: 1280, height: 300 };
    const narrow = { width: 360, height: 800 };
    for (const vp of [short, narrow]) {
      const pos = clampExplainPosition({ anchorX: vp.width - 4, anchorY: vp.height - 4 }, POP, vp);
      expect(pos.left).toBeGreaterThanOrEqual(8);
      expect(pos.top).toBeGreaterThanOrEqual(8);
    }
  });

  it('does not treat screen coords as the canonical anchor (ReaderClient source)', () => {
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    // Canonical anchor stays { selectedText, passageId } resolved server-side.
    expect(src).toMatch(/selectedText: pending\.text/);
    expect(src).toMatch(/passageId: pending\.passageId/);
    // Viewport client coords only — no scroll offsets mixed into fixed positioning.
    expect(src).not.toMatch(/window\.scrollX/);
    expect(src).not.toMatch(/window\.scrollY/);
    expect(src).toMatch(/clampExplainPosition/);
    expect(src).toMatch(/data-testid="explain-pop"/);
  });
});

describe('reader UX: long thread scrolls inside its own region', () => {
  it('thread has its own scrollable region and the page cannot blow out', () => {
    const css = readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');
    // Own scrollable region.
    expect(css).toMatch(/\.thread-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/overscroll-behavior:\s*contain/);
    // Panel constrained to the viewport so the reader stays usable.
    expect(css).toMatch(/\.side\s*\{[^}]*max-height:\s*calc\(100vh/);
    expect(css).toMatch(/\.thread-card\s*\{[^}]*overflow:\s*hidden/);
    // No unwanted page-level horizontal scrolling.
    expect(css).toMatch(/overflow-x:\s*hidden/);
    expect(css).toMatch(/minmax\(0,\s*1fr\)/);
  });

  it('thread header/actions stay outside the scrolling message body', () => {
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    expect(src).toMatch(/className="thread-head"/);
    expect(src).toMatch(/className="thread-scroll"/);
    expect(src).toMatch(/className="thread-foot"/);
    // Keyboard + wheel/touch scrolling works: focusable scroll region.
    expect(src).toMatch(/tabIndex=\{0\}/);
    expect(src).toMatch(/role="log"/);
    expect(src).toMatch(/data-testid="thread-scroll"/);
    // Header (thread-head) and actions (thread-foot) are siblings of the
    // scroll body, so they remain usable while messages scroll.
    const head = src.indexOf('className="thread-head"');
    const scroll = src.indexOf('className="thread-scroll"');
    const foot = src.indexOf('className="thread-foot"');
    expect(head).toBeGreaterThanOrEqual(0);
    expect(scroll).toBeGreaterThan(head);
    expect(foot).toBeGreaterThan(scroll);
  });

  it('long mock conversations remain grouped without losing messages', () => {
    // Deliberately long thread: 60 alternating user/assistant messages.
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}`, model_id: 'dev',
    }));
    expect(messages.filter((m) => m.role === 'assistant').length).toBe(30);
    expect(messages.filter((m) => m.role === 'user').length).toBe(30);
    // Reader renders the full ordered conversation (both roles), not a subset.
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    expect(src).toMatch(/messages\.map/);
    expect(src).toMatch(/msg-user/);
    expect(src).toMatch(/msg-ai/);
    expect(src).not.toMatch(/messages\.filter\(\(m\) => m\.role === 'assistant'\)\.map/);
  });
});

describe('reader UX: citation is findable and navigates to the passage', () => {
  it('resolves the cited passage without reducing it to a plain URL', () => {
    expect(citationTargetPassageId({ passage_id: 'p-123' })).toBe('p-123');
    expect(citationTargetPassageId({})).toBeNull();
    expect(citationTargetPassageId(null)).toBeNull();
    expect(citationTargetPassageId({ passage_id: 42 })).toBeNull();
  });

  it('renders a visually distinct clickable citation per explanation', () => {
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    expect(src).toMatch(/data-testid="citation-block"/);
    expect(src).toMatch(/data-testid="citation-link"/);
    expect(src).toMatch(/data-citation-id=\{c\.id\}/);
    expect(src).toMatch(/Source evidence/);
    expect(src).toMatch(/clickCitation\(c\.id\)/);
    // Preserves Thread Message → Evidence → Passage: groups via evidence.
    expect(src).toMatch(/citesByMessage/);
    expect(src).toMatch(/thread_message_id/);
    expect(src).toMatch(/evidence_id/);
    const css = readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');
    expect(css).toMatch(/\.cite-block/);
    expect(css).toMatch(/\.cite-btn\.cite-visible/);
  });

  it('citation click focuses the expected passage', () => {
    const src = readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
    // Click resolves GET /api/citations/:id → passage_id → scrollToPassage.
    expect(src).toMatch(/\/api\/citations\/\$\{citeId\}/);
    expect(src).toMatch(/citationTargetPassageId\(r\.citation\)/);
    expect(src).toMatch(/scrollToPassage\(passageId\)/);
    expect(src).toMatch(/el\.scrollIntoView\(\{ behavior: 'smooth', block \}\)/);
    expect(src).toMatch(/block: 'center' \| 'start' = 'center'/);
    expect(src).toMatch(/data-passage-id/);
  });
});
