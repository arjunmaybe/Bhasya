import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

describe('thread panel: wider readable layout', () => {
  it('panel scales 420-520px on desktop instead of a narrow fixed column', () => {
    const c = css();
    expect(c).toMatch(/\.reader\s*\{[^}]*clamp\(420px,[^}]*520px\)/);
    expect(c).toMatch(/minmax\(0,\s*1fr\)/);
    // Old narrow-only width is gone as the desktop panel width.
    expect(c).not.toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*360px/);
  });

  it('stays responsive with no horizontal overflow', () => {
    const c = css();
    expect(c).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(c).toMatch(/overflow-x:\s*hidden/);
    expect(c).toMatch(/\.reader\s*\{[^}]*max-width:\s*100%/);
  });

  it('keeps the reading column focused and restrained', () => {
    const c = css();
    expect(c).toMatch(/\.doc-inner/);
    expect(c).toMatch(/max-width:\s*68ch/);
  });

  it('newest-question marker stays restrained', () => {
    const c = css();
    expect(c).toMatch(/\.msg-user-latest/);
    expect(c).not.toMatch(/\.msg-user-latest[^}]*linear-gradient/i);
    expect(c).not.toMatch(/\.msg-user-latest[^}]*box-shadow/i);
    expect(c).not.toMatch(/\.msg-user-latest[^}]*border-radius:\s*20px/);
    const s = src();
    expect(s).not.toMatch(/How it works/);
    expect(s).not.toMatch(/·/);
  });
});

describe('thread panel: conversation has its own scroll container', () => {
  it('dedicated ref drives the conversation container, not the page', () => {
    const s = src();
    expect(s).toMatch(/threadScrollRef\s*=\s*useRef<HTMLDivElement>\(null\)/);
    expect(s).toMatch(/ref=\{threadScrollRef\}/);
    expect(s).toMatch(/data-testid="thread-scroll"/);
    expect(s).toMatch(/role="log"/);
    expect(s).toMatch(/tabIndex=\{0\}/);
    expect(s).toMatch(/onScroll=\{handleThreadScroll\}/);
    const c = css();
    expect(c).toMatch(/\.thread-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(c).toMatch(/overscroll-behavior:\s*contain/);
    expect(c).toMatch(/\.side\s*\{[^}]*max-height:\s*calc\(100vh/);
  });
});

describe('thread panel: follow-up anchors to the newest interaction', () => {
  it('submitting a follow-up flags the new interaction and scrolls the container', () => {
    const s = src();
    // Flag set on submit, consumed when fresh messages land.
    expect(s).toMatch(/justSubmittedRef\.current\s*=\s*true/);
    expect(s).toMatch(/justSubmittedRef\.current\s*=\s*false/);
    // Container scrolled directly to the newest content.
    expect(s).toMatch(/threadScrollRef\.current/);
    expect(s).toMatch(/el\.scrollTop\s*=\s*el\.scrollHeight/);
  });

  it('anchoring never drags the page back to the passage on follow-up', () => {
    const s = src();
    const start = s.indexOf('async function sendFollowup');
    expect(start).toBeGreaterThanOrEqual(0);
    // sendFollowup body ends at the next top-level function.
    const end = s.indexOf('function handlePassageClick', start);
    const body = s.slice(start, end === -1 ? undefined : end);
    expect(body).not.toMatch(/scrollToPassage/);
    expect(body).not.toMatch(/scrollIntoView/);
  });

  it('anchoring is state-driven, not arbitrary timeouts', () => {
    const s = src();
    const anchorIdx = s.indexOf('el.scrollTop = el.scrollHeight');
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    // No setTimeout wrapping the conversation scroll assignment.
    const window = s.slice(Math.max(0, anchorIdx - 400), anchorIdx);
    expect(window).not.toMatch(/setTimeout/);
    // Effect re-runs on conversation state.
    expect(s).toMatch(/\[[^\]]*messages,[^\]]*cites,[^\]]*openThreadId/);
  });

  it('keyboard focus returns to the composer after submission', () => {
    const s = src();
    expect(s).toMatch(/followupInputRef\s*=\s*useRef<HTMLInputElement>\(null\)/);
    expect(s).toMatch(/ref=\{followupInputRef\}/);
    expect(s).toMatch(/followupInputRef\.current\?\.focus\(\)/);
  });
});

describe('thread panel: passage/thread identity preserved', () => {
  it('panel stays keyed to its own thread/anchor/passage', () => {
    const s = src();
    expect(s).toMatch(/key=\{openThreadId\}/);
    expect(s).toMatch(/data-thread-id=\{openThreadId\}/);
    expect(s).toMatch(/data-passage-id=\{activePassageId/);
    expect(s).toMatch(/data-anchor-id=\{activeAnchorId/);
    expect(s).toMatch(/setOpenThreadId\(result\.threadId\)/);
    expect(s).toMatch(/setActiveAnchorId\(anchor\.anchorId\)/);
    expect(s).toMatch(/threadSel\.slice\(0, 280\)/);
  });

  it('close/reopen behavior unchanged', () => {
    const s = src();
    expect(s).toMatch(/Close and return to reading/);
    expect(s).toMatch(/closeThread\(true\)/);
    expect(s).toMatch(/clearThreadState\(\)/);
    expect(s).toMatch(/data-testid="view-passage-btn"/);
  });
});

describe('thread panel: citation behavior unchanged', () => {
  it('citation UI and grouping intact', () => {
    const s = src();
    expect(s).toMatch(/data-testid="citation-block"/);
    expect(s).toMatch(/data-testid="citation-link"/);
    expect(s).toMatch(/citesByMessage/);
    expect(s).toMatch(/clickCitation\(c\.id\)/);
    expect(s).toMatch(/scrollToPassage\(passageId\)/);
    const c = css();
    expect(c).toMatch(/\.cite-block/);
    expect(c).toMatch(/\.cite-btn\.cite-visible/);
  });
});

describe('thread panel: manual reading is not overridden', () => {
  it('near-bottom tracking gates auto-scroll', () => {
    const s = src();
    expect(s).toMatch(/stickToBottomRef/);
    expect(s).toMatch(/handleThreadScroll/);
    expect(s).toMatch(/scrollHeight\s*-\s*el\.scrollTop\s*-\s*el\.clientHeight/);
    // Gated effect: bails out unless the user submitted or was near bottom.
    expect(s).toMatch(/justSubmittedRef\.current\s*\|\|\s*stickToBottomRef\.current/);
    expect(s).toMatch(/if\s*\(!shouldStick\)\s*return;/);
  });
});
