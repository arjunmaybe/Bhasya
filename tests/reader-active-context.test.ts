import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

describe('reader active context: thread/anchor/passage stay keyed together', () => {
  it('tracks explicit active anchor and passage alongside the open thread', () => {
    const s = src();
    expect(s).toMatch(/activeAnchorId/);
    expect(s).toMatch(/activePassageId/);
    expect(s).toMatch(/setActiveAnchorId\(anchor\.anchorId\)/);
    expect(s).toMatch(/setActivePassageId\(anchor\.passageId/);
    expect(s).toMatch(/setOpenThreadId\(result\.threadId\)/);
  });

  it('keys the panel to the thread so A and B never share UI state', () => {
    const s = src();
    expect(s).toMatch(/key=\{openThreadId\}/);
    expect(s).toMatch(/data-thread-id=\{openThreadId\}/);
    expect(s).toMatch(/data-passage-id=\{activePassageId/);
    expect(s).toMatch(/data-anchor-id=\{activeAnchorId/);
  });

  it('shows the passage excerpt verbatim without injecting it into the AI answer', () => {
    const s = src();
    // Excerpt lives in its own header element, sliced from the selection.
    expect(s).toMatch(/threadSel\.slice\(0, 280\)/);
    // Assistant messages render provider content only — never concatenated
    // with the selection to fake distinct answers.
    expect(s).not.toMatch(/m\.content.*pending\.text/);
    expect(s).not.toMatch(/pending\.text.*m\.content/);
    expect(s).toMatch(/<div className="msg-ai">\{m\.content\}<\/div>/);
  });
});

describe('reader UX: passage and thread stay visibly associated', () => {
  it('marks the active passage and exposes it to assistive tech', () => {
    const s = src();
    expect(s).toMatch(/data-active=\{isActive \? 'true' : 'false'\}/);
    expect(s).toMatch(/passage active/);
    expect(s).toMatch(/aria-current=\{isActive \? 'true' : undefined\}/);
    expect(css()).toMatch(/\.passage\.active/);
  });

  it('keeps each thread attached to its own passage inline', () => {
    const s = src();
    expect(s).toMatch(/data-testid="passage-threads"/);
    expect(s).toMatch(/data-testid="passage-thread-link"/);
    expect(s).toMatch(/data-thread-id=\{h\.thread_id\}/);
    expect(s).toMatch(/openThread\(h\.thread_id as string, h\.selected_text\)/);
  });

  it('highlight marks reopen their own thread; the list stays passage-keyed', () => {
    const s = src();
    expect(s).toMatch(/closest\?\.\('mark\.hl'\)/);
    expect(s).toMatch(/hlByPassage\.get\(passageId\)/);
    expect(s).toMatch(/data-testid="highlight-link"/);
    expect(s).toMatch(/data-passage-id=\{h\.passage_id\}/);
    expect(s).toMatch(/data-anchor-id=\{h\.anchor_id\}/);
  });

  it('thread panel offers an explicit return to its passage', () => {
    const s = src();
    expect(s).toMatch(/data-testid="view-passage-btn"/);
    expect(s).toMatch(/View passage in document/);
    expect(s).toMatch(/if \(activePassageId\) scrollToPassage\(activePassageId\)/);
  });

  it('closing the panel returns naturally to reading', () => {
    const s = src();
    expect(s).toMatch(/Close and return to reading/);
    expect(s).toMatch(/closeThread\(true\)/);
    expect(s).toMatch(/clearThreadState\(\)/);
  });

  it('reopening a thread returns to its passage context', () => {
    const s = src();
    // openThread resolves context from the persisted highlight, then scrolls.
    expect(s).toMatch(/highlights\.find\(\(h\) => h\.thread_id === threadId\)/);
    expect(s).toMatch(/if \(contextPassageId\) scrollToPassage\(contextPassageId\)/);
  });
});

describe('reader loading and calm editorial styling', () => {
  it('shows restrained loading state while explaining', () => {
    const s = src();
    expect(s).toMatch(/data-testid="thread-loading"/);
    expect(s).toMatch(/Preparing explanation/);
    expect(css()).toMatch(/\.skeleton/);
    expect(css()).toMatch(/\.thread-loading/);
  });

  it('keeps the reading column comfortable and the document visible', () => {
    const c = css();
    expect(c).toMatch(/\.doc-inner/);
    expect(c).toMatch(/max-width:\s*68ch/);
    expect(c).toMatch(/\.side\s*\{[^}]*max-height:\s*calc\(100vh/);
  });

  it('honours anti-vibe constraints', () => {
    const s = src();
    const c = css();
    expect(s).not.toMatch(/animate-ping/);
    expect(c).not.toMatch(/animate-ping/);
    expect(c).not.toMatch(/linear-gradient.*purple/i);
    expect(c).not.toMatch(/#[89][0-9a-f]f.*gradient/i);
    expect(s).not.toMatch(/How it works/);
    // No middle dot as a repetitive separator in UI copy.
    expect(s).not.toMatch(/·/);
    // Consistent small radii, no pill buttons.
    expect(c).not.toMatch(/border-radius:\s*20px/);
    expect(c).toMatch(/border-radius:\s*6px/);
  });
});
