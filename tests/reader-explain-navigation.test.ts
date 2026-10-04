import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');

/** Slice a top-level function body: from marker to the next marker. */
function bodyBetween(s: string, startMarker: string, endMarker: string): string {
  const start = s.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = s.indexOf(endMarker, start);
  return s.slice(start, end === -1 ? undefined : end);
}

/** Isolate the one-shot Explain navigation effect by its leading comment. */
function explainNavBody(s: string): string {
  const start = s.indexOf('One-shot Explain navigation');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = s.indexOf('Return keyboard focus', start);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
}

describe('explain navigation: selection near bottom reveals the new passage thread', () => {
  it('arms a one-shot Explain target from the authoritative anchor passage', () => {
    const s = src();
    expect(s).toMatch(/pendingExplainRef\s*=\s*useRef<string \| null>\(null\)/);
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    // Authoritative passage, stable across optimistic → authoritative.
    expect(body).toMatch(/anchor\.passageId \?\? selectedPassageId/);
    expect(body).toMatch(/pendingExplainRef\.current = explainPassageId/);
  });

  it('navigates to the newly created/activated passage thread itself', () => {
    const s = src();
    const nav = explainNavBody(s);
    // Existing DOM/ref structure: article passage node via docRef.
    expect(nav).toMatch(/docRef\.current\?\.querySelector\(`\[data-passage-id="\$\{passageId\}"\]`\)/);
    // Reuses the existing passage helper, requesting the top ('start') of
    // the reading viewport for the newly explained passage.
    expect(nav).toMatch(/scrollToPassage\(passageId, 'start'\)/);
    expect(s).toMatch(/el\.scrollIntoView\(\{ behavior: 'smooth', block \}\)/);
  });

  it('waits for the authoritative thread DOM before scrolling once', () => {
    const s = src();
    const nav = explainNavBody(s);
    // No real thread yet → no navigation.
    expect(nav).toMatch(/if \(!passageId \|\| !openThreadId\) return;/);
    // Thread card must have mounted (hosts the conversation container).
    expect(nav).toMatch(/if \(!threadScrollRef\.current\) return;/);
    // Passage node must exist; otherwise retry on the next state update.
    expect(nav).toMatch(/if \(!passageEl\) return;/);
    // Only the currently active passage/thread navigates (no stale target).
    expect(nav).toMatch(/if \(activePassageId !== passageId\) return;/);
  });
});

describe('explain navigation: optimistic → authoritative transition', () => {
  it('arms at anchor time and resolves after authoritative detail lands', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    // Armed once the anchor resolves — before streaming chunks arrive.
    const anchorIdx = body.indexOf('pendingExplainRef.current = explainPassageId');
    const streamIdx = body.indexOf('/explain/stream');
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(streamIdx).toBeGreaterThan(anchorIdx);
    // Shared completion still keys the exact triple and ingests detail.
    expect(body).toMatch(/setOpenThreadId\(threadId\)/);
    expect(body).toMatch(/setActivePassageId\(anchor\.passageId/);
    expect(body).toMatch(/applyThreadDetail\(detail\)/);
    // Navigation effect re-runs when authoritative state lands.
    const nav = explainNavBody(s);
    expect(nav).toMatch(/\[messages, highlights, openThreadId, activePassageId\]/);
  });

  it('uses the stable passage id, not a temporary thread/question id', () => {
    const s = src();
    const nav = explainNavBody(s);
    expect(nav).toMatch(/pendingExplainRef/);
    expect(nav).not.toMatch(/pendingQuestionRef/);
    expect(nav).not.toMatch(/data-message-id/);
    expect(nav).toMatch(/data-passage-id/);
  });
});

describe('explain navigation: exactly once, never per chunk', () => {
  it('does not scroll inside streamed chunk handlers', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    const followBody = bodyBetween(s, 'async function sendFollowup', 'function handlePassageClick');
    for (const b of [body, followBody]) {
      let idx = b.indexOf('receivedAny = true');
      expect(idx).toBeGreaterThanOrEqual(0);
      while (idx !== -1) {
        // On-chunk closure only: accumulation with no scrolling and no
        // navigation arming. Abort/failure clearing lives outside this
        // closure (after the stream settles) and is covered separately.
        const window = b.slice(idx, idx + 200);
        expect(window).not.toMatch(/scrollTop/);
        expect(window).not.toMatch(/scrollIntoView/);
        expect(window).not.toMatch(/scrollToPassage/);
        idx = b.indexOf('receivedAny = true', idx + 1);
      }
    }
  });

  it('is one-shot and state-synchronized without timers', () => {
    const s = src();
    const nav = explainNavBody(s);
    // Gated: bails unless a pending Explain target exists.
    expect(nav).toMatch(/pendingExplainRef\.current/);
    // One-shot: clears after the new thread is revealed.
    expect(nav).toMatch(/pendingExplainRef\.current\s*=\s*null/);
    // DOM/state-synchronized, not an arbitrary delay.
    expect(nav).toMatch(/useLayoutEffect/);
    expect(nav).not.toMatch(/setTimeout/);
    // No snap-to-bottom anywhere in the Reader.
    expect(s).not.toMatch(/scrollHeight/);
  });
});

describe('explain navigation: follow-up exact-question behavior preserved', () => {
  it('follow-up still targets the exact new user question', () => {
    const s = src();
    expect(s).toMatch(/pendingQuestionRef\.current = tempId/);
    expect(s).toMatch(/pendingQuestionRef\.current = userMessageId/);
    expect(s).toMatch(/pendingQuestionRef\.current\s*=\s*null/);
    expect(s).toMatch(/data-message-id=\{m\.id\}/);
    expect(s).toMatch(/querySelector\(`\[data-message-id="\$\{targetId\}"\]`\)/);
    expect(s).toMatch(/clientHeight \* 0\.2/);
    expect(s).toMatch(/container\.scrollTop\s*=\s*Math\.max\(0, placeAt\)/);
  });

  it('follow-up and Explain navigation use separate one-shot targets', () => {
    const s = src();
    expect(s).toMatch(/pendingQuestionRef\s*=\s*useRef<string \| null>\(null\)/);
    expect(s).toMatch(/pendingExplainRef\s*=\s*useRef<string \| null>\(null\)/);
    const nav = explainNavBody(s);
    expect(nav).not.toMatch(/pendingQuestionRef/);
  });
});

describe('explain navigation: aborted/failed requests never navigate stale', () => {
  it('clears the pending Explain target when no real thread exists', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    // Aborted streams never navigate.
    expect(body).toMatch(/if \(!isCurrent\(\)\) \{\s*pendingExplainRef\.current = null;/);
    // Failed requests clear instead of leaving a misleading target.
    expect(body).toMatch(/pendingExplainRef\.current = null;\s*setError/);
    // Closing destroys the pending target with the thread.
    const clearBody = bodyBetween(s, 'function clearThreadState()', 'function closeThread');
    expect(clearBody).toMatch(/pendingExplainRef\.current = null/);
  });

  it('navigation requires the authoritative open thread', () => {
    const s = src();
    const nav = explainNavBody(s);
    expect(nav).toMatch(/if \(!passageId \|\| !openThreadId\) return;/);
    expect(nav).toMatch(/if \(activePassageId !== passageId\) return;/);
  });
});

describe('explain navigation alignment: new thread to top, all others centered', () => {
  it('Explain one-shot navigation requests block start', () => {
    const s = src();
    const nav = explainNavBody(s);
    expect(nav).toMatch(/scrollToPassage\(passageId, 'start'\)/);
  });

  it('shared helper keeps center as the default alignment', () => {
    const s = src();
    expect(s).toMatch(
      /const scrollToPassage = useCallback\(\(passageId: string, block: 'center' \| 'start' = 'center'\)/,
    );
    expect(s).toMatch(/el\.scrollIntoView\(\{ behavior: 'smooth', block \}\)/);
  });

  it('every non-Explain caller relies on the centered default', () => {
    const s = src();
    const calls = [...s.matchAll(/scrollToPassage\(([^)]*)\)/g)].map((m) => m[1].trim());
    // 6 existing callers (reopen, close, citation, mark fallback, view-passage
    // button, highlight-list fallback) plus the single Explain call.
    expect(calls.length).toBe(7);
    const centered = calls.filter((args) => !args.includes("'start'"));
    expect(centered.length).toBe(6);
    expect(s).toMatch(/if \(contextPassageId\) scrollToPassage\(contextPassageId\)/);
    expect(s).toMatch(/if \(activePassageId\) scrollToPassage\(activePassageId\)/);
  });

  it('follow-up exact-question navigation is untouched by the alignment change', () => {
    const s = src();
    const start = s.indexOf('One-shot follow-up navigation');
    const end = s.indexOf('One-shot Explain navigation', start);
    const followNav = s.slice(start, end);
    expect(followNav).toMatch(/container\.scrollTop\s*=\s*Math\.max\(0, placeAt\)/);
    expect(followNav).not.toMatch(/scrollIntoView/);
    expect(followNav).not.toMatch(/scrollToPassage/);
    expect(followNav).not.toMatch(/'start'/);
  });

  it('passage scroll-margin-top behavior is preserved', () => {
    const c = readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');
    expect(c).toMatch(/\.passage\s*\{[^}]*scroll-margin-top:\s*20px/);
  });
});

describe('explain navigation: compact/expanded behavior unchanged', () => {
  it('Explain still expands; article resume and compact reopen are untouched', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    expect(body).toMatch(/setPanelMode\('expanded'\)/);
    expect(s).toMatch(/useState<'compact' \| 'expanded'>\('compact'\)/);
    expect(s).toMatch(/data-panel=\{panelMode\}/);
    const collapseBody = bodyBetween(s, 'handleArticleClick', 'document.addEventListener');
    expect(collapseBody).toMatch(/setPanelMode\('compact'\)/);
    expect(collapseBody).not.toMatch(/clearThreadState/);
    const expandBody = bodyBetween(s, 'handleCompactExpand', '}, [panelMode, openThreadId]);');
    expect(expandBody).toMatch(/setPanelMode\('expanded'\)/);
    expect(expandBody).not.toMatch(/scrollTop/);
    expect(expandBody).not.toMatch(/scrollIntoView/);
  });
});
