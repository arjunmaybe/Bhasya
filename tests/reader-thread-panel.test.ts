import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

/** Slice a top-level function body: from marker to the next marker. */
function bodyBetween(s: string, startMarker: string, endMarker: string): string {
  const start = s.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = s.indexOf(endMarker, start);
  return s.slice(start, end === -1 ? undefined : end);
}

describe('panel state: explicit compact/expanded, never inferred', () => {
  it('1. initial thread panel is compact', () => {
    const s = src();
    expect(s).toMatch(/useState<'compact' \| 'expanded'>\('compact'\)/);
    expect(s).toMatch(/data-panel=\{panelMode\}/);
  });

  it('2. Explain transitions the thread panel to expanded mode', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    // Shared completion opens the exact thread whether streamed or fallback.
    expect(body).toMatch(/finishExplain/);
    expect(body).toMatch(/setOpenThreadId\(threadId\)/);
    expect(body).toMatch(/setPanelMode\('expanded'\)/);
    expect(s).toMatch(/reader-expanded/);
  });

  it('16. thread close stays distinct from compact/expanded state', () => {
    const s = src();
    const closeBody = bodyBetween(s, 'function closeThread', 'async function openThread');
    // Close destroys thread state (and returns the panel to baseline).
    expect(closeBody).toMatch(/clearThreadState\(\)/);
    // Collapse preserves everything: the article handler only flips the mode.
    const collapseBody = bodyBetween(s, 'handleArticleClick', 'document.addEventListener');
    expect(collapseBody).toMatch(/setPanelMode\('compact'\)/);
    expect(collapseBody).not.toMatch(/clearThreadState/);
    expect(collapseBody).not.toMatch(/setMessages/);
    expect(collapseBody).not.toMatch(/setCites/);
    expect(collapseBody).not.toMatch(/setEvidence/);
  });
});

describe('panel layout: expanded workspace plus readable article', () => {
  it('3. expanded mode occupies approximately half the desktop workspace', () => {
    const c = css();
    expect(c).toMatch(/\.reader-expanded\s*\{[^}]*clamp\(520px,\s*48vw,\s*720px\)/);
    expect(c).toMatch(/@media\s*\(min-width:\s*901px\)/);
  });

  it('compact mode is a restrained sidebar, not the old cramped width', () => {
    const c = css();
    expect(c).toMatch(/\.reader\s*\{[^}]*clamp\(340px,[^}]*400px\)/);
    expect(c).toMatch(/minmax\(0,\s*1fr\)/);
  });

  it('4. article remains readable in the remaining workspace', () => {
    const c = css();
    expect(c).toMatch(/\.doc-inner/);
    expect(c).toMatch(/max-width:\s*68ch/);
  });

  it('expanded excerpt has room without becoming a tiny scroll box', () => {
    const c = css();
    expect(c).toMatch(/\.reader-expanded \.thread-card \.sel/);
    // Desktop excerpt stays plain flow content: no overflow rule outside the
    // mobile media query.
    const desktop = c.slice(0, c.indexOf('@media'));
    expect(desktop).not.toMatch(/\.sel\s*\{[^}]*overflow-y/);
    // Narrow-viewport exception only: mobile-expanded excerpt scrolls
    // internally under a line-based cap (see reader-mobile-excerpt tests).
    expect(c).toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*\.reader-expanded \.thread-card \.sel\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('17. mobile/tablet layout does not produce horizontal overflow', () => {
    const c = css();
    expect(c).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(c).toMatch(/\.reader,\s*\.reader-expanded\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}/);
    expect(c).toMatch(/\.reader-expanded \.thread-card\s*\{\s*max-height:\s*82vh/);
    expect(c).toMatch(/overflow-x:\s*hidden/);
    expect(c).toMatch(/\.reader\s*\{[^}]*max-width:\s*100%/);
  });

  it('restrained visual language holds in both modes', () => {
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

describe('conversation scroll: one primary container', () => {
  it('5. expanded mode has an intentional conversation scroll container', () => {
    const s = src();
    expect(s).toMatch(/threadScrollRef\s*=\s*useRef<HTMLDivElement>\(null\)/);
    expect(s).toMatch(/ref=\{threadScrollRef\}/);
    expect(s).toMatch(/data-testid="thread-scroll"/);
    expect(s).toMatch(/role="log"/);
    expect(s).toMatch(/tabIndex=\{0\}/);
    const c = css();
    expect(c).toMatch(/\.thread-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(c).toMatch(/overscroll-behavior:\s*contain/);
    expect(c).toMatch(/\.side\s*\{[^}]*max-height:\s*calc\(100vh/);
  });
});

describe('follow-up navigation: exact question, not the bottom', () => {
  it('6. follow-up submission targets the exact new USER QUESTION', () => {
    const s = src();
    // Optimistic question appears immediately with a client-local id…
    expect(s).toMatch(/userMessageId/);
    expect(s).toMatch(/pendingQuestionRef\.current = tempId/);
    // …then anchors to the authoritative persisted id on completion.
    expect(s).toMatch(/pendingQuestionRef\.current = userMessageId/);
    // Every message node is addressable by id.
    expect(s).toMatch(/data-message-id=\{m\.id\}/);
    // Navigation resolves THAT node inside the conversation container.
    expect(s).toMatch(/querySelector\(`\[data-message-id="\$\{targetId\}"\]`\)/);
    expect(s).toMatch(/pendingQuestionRef/);
  });

  it('7. the question lands visibly within the conversation viewport', () => {
    const s = src();
    // Placed near the upper part of the viewport (answer fits beneath),
    // clamped so the container never scrolls negative.
    expect(s).toMatch(/clientHeight \* 0\.2/);
    expect(s).toMatch(/container\.scrollTop\s*=\s*Math\.max\(0, placeAt\)/);
    // Only the conversation container scrolls — never the whole page.
    const navIdx = s.indexOf('container.scrollTop = Math.max(0, placeAt)');
    expect(navIdx).toBeGreaterThanOrEqual(0);
    const window = s.slice(Math.max(0, navIdx - 600), navIdx + 100);
    expect(window).not.toMatch(/scrollIntoView/);
  });

  it('8. unrelated renders do not force scrolling', () => {
    const s = src();
    // Gated: bails out unless a pending question target exists.
    expect(s).toMatch(/if\s*\(!targetId \|\| !openThreadId\) return;/);
    // One-shot: the pending target clears after successful navigation.
    expect(s).toMatch(/pendingQuestionRef\.current\s*=\s*null/);
    // Effect re-runs on conversation state only.
    expect(s).toMatch(/\[messages,\s*openThreadId\]/);
    // State-synchronized, not arbitrary timeouts.
    const navIdx = s.indexOf('container.scrollTop = Math.max(0, placeAt)');
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(s.slice(Math.max(0, navIdx - 600), navIdx)).not.toMatch(/setTimeout/);
  });

  it('9. manual scrolling through older messages remains possible', () => {
    const s = src();
    // No snap-to-bottom anywhere in the conversation flow.
    expect(s).not.toMatch(/scrollHeight/);
    expect(s).not.toMatch(/scrollTop\s*=\s*\w+\.scrollHeight/);
  });

  it('keyboard focus returns to the composer after submission', () => {
    const s = src();
    expect(s).toMatch(/followupInputRef\s*=\s*useRef<HTMLInputElement>\(null\)/);
    expect(s).toMatch(/ref=\{followupInputRef\}/);
    expect(s).toMatch(/followupInputRef\.current\?\.focus\(\)/);
  });
});

describe('article resume: intentional interaction compacts, thread survives', () => {
  it('10. intentional article interaction collapses expanded -> compact', () => {
    const s = src();
    expect(s).toMatch(/handleArticleClick/);
    expect(s).toMatch(/<article[^>]*onClick=\{handleArticleClick\}/);
    const collapseBody = bodyBetween(s, 'handleArticleClick', 'document.addEventListener');
    expect(collapseBody).toMatch(/setPanelMode\('compact'\)/);
    // No generic document-level click listener collapses the panel.
    expect(s).not.toMatch(/document\.addEventListener\('click'/);
    expect(s).not.toMatch(/document\.addEventListener\("click"/);
    expect(s).not.toMatch(/document\.addEventListener\('mousedown'/);
  });

  it('thread-adjacent clicks never collapse the panel', () => {
    const s = src();
    const collapseBody = bodyBetween(s, 'handleArticleClick', 'document.addEventListener');
    expect(collapseBody).toMatch(/mark\.hl/);
    expect(collapseBody).toMatch(/\.passage-threads/);
    expect(collapseBody).toMatch(/\.explain-pop/);
    // An in-progress text selection starts an Explain flow, not a resume.
    expect(collapseBody).toMatch(/getSelection/);
  });

  it('11. collapsing does not destroy or reset the thread', () => {
    const s = src();
    const collapseBody = bodyBetween(s, 'handleArticleClick', 'document.addEventListener');
    expect(collapseBody).not.toMatch(/clearThreadState/);
    expect(collapseBody).not.toMatch(/setMessages\(\[\]\)/);
    expect(collapseBody).not.toMatch(/setOpenThreadId\(null\)/);
  });

  it('12. reopening/continuing the same thread preserves messages and citations', () => {
    const s = src();
    const body = bodyBetween(s, 'async function openThread', 'async function explain()');
    expect(body).toMatch(/setOpenThreadId\(threadId\)/);
    // Ingestion preserves ids/citations; content is display-trimmed only.
    expect(body).toMatch(/applyThreadDetail\(r\)/);
    expect(body).toMatch(/setPanelMode\('expanded'\)/);
    expect(s).toMatch(/key=\{openThreadId\}/);
  });
});

describe('thread isolation and citations', () => {
  it('13. selecting another passage plus Explain expands that thread', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    expect(body).toMatch(/setActiveAnchorId\(anchor\.anchorId\)/);
    expect(body).toMatch(/setActivePassageId\(anchor\.passageId/);
    expect(body).toMatch(/setPanelMode\('expanded'\)/);
    // The passage excerpt renders verbatim in the expanded panel.
    expect(s).toMatch(/threadSel\.slice\(0, 280\)/);
  });

  it('14. passage A and passage B remain strictly isolated', () => {
    const s = src();
    expect(s).toMatch(/key=\{openThreadId\}/);
    expect(s).toMatch(/data-thread-id=\{openThreadId\}/);
    expect(s).toMatch(/data-passage-id=\{activePassageId/);
    expect(s).toMatch(/data-anchor-id=\{activeAnchorId/);
  });

  it('15. citation navigation remains correct', () => {
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

describe('compact reopen: click the compact surface to expand the same thread', () => {
  it('clicking the compact thread panel re-expands it', () => {
    const s = src();
    expect(s).toMatch(/handleCompactExpand/);
    // Handler sits on the thread card itself — never a document listener.
    const cardIdx = s.indexOf('className="thread-card"');
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    const onClickIdx = s.indexOf('onClick={handleCompactExpand}', cardIdx);
    expect(onClickIdx).toBeGreaterThan(cardIdx);
    expect(onClickIdx - cardIdx).toBeLessThan(160);
    const body = bodyBetween(s, 'handleCompactExpand', 'document.addEventListener');
    expect(body).toMatch(/panelMode !== 'compact'/);
    expect(body).toMatch(/setPanelMode\('expanded'\)/);
  });

  it('re-expanding preserves the same thread, messages, and citations', () => {
    const s = src();
    const body = bodyBetween(s, 'handleCompactExpand', '}, [panelMode, openThreadId]);');
    // Nothing is refetched, cleared, toggled, or reset.
    expect(body).not.toMatch(/clearThreadState/);
    expect(body).not.toMatch(/setOpenThreadId/);
    expect(body).not.toMatch(/setMessages/);
    expect(body).not.toMatch(/setCites/);
    expect(body).not.toMatch(/setEvidence/);
    expect(body).not.toMatch(/browserReq/);
    // Same scroll container persists, so scroll position is left alone.
    expect(body).not.toMatch(/scrollTop/);
    expect(body).not.toMatch(/scrollIntoView/);
  });

  it('compact controls keep their normal actions instead of toggling', () => {
    const s = src();
    const body = bodyBetween(s, 'handleCompactExpand', 'document.addEventListener');
    expect(body).toMatch(/button/);
    expect(body).toMatch(/closest/);
    expect(body).toMatch(/input/);
    expect(body).toMatch(/form/);
    // Cursor signals the reopenable surface without loud UI.
    const c = css();
    expect(c).toMatch(/\.reader\[data-panel="compact"\] \.thread-card\s*\{\s*cursor:\s*pointer/);
  });

  it('reopen path never interferes with article selection', () => {
    const s = src();
    const body = bodyBetween(s, 'handleCompactExpand', '}, [panelMode, openThreadId]);');
    expect(body).not.toMatch(/getSelection/);
    expect(body).not.toMatch(/removeAllRanges/);
    expect(body).not.toMatch(/setPending/);
    // Canonical selection flow is untouched elsewhere.
    expect(s).toMatch(/selectedText: pending\.text/);
    expect(s).toMatch(/passageId: pending\.passageId/);
  });
});

describe('answer whitespace: edge blank lines never become layout space', () => {
  it('message display trims edge blank lines while keeping ids and content intact', () => {
    const s = src();
    expect(s).toMatch(/function trimMessageEdges\(text: string\): string/);
    // Leading and trailing blank-line runs are stripped.
    expect(s).toMatch(/\[\s*\\t\]\*\\r\?\\n/);
    // Ingestion preserves everything else via spread; only content is trimmed.
    expect(s).toMatch(/\.\.\.m, content: trimMessageEdges\(m\.content\)/);
    // All three detail paths ingest through the single helper.
    for (const [start, end] of [
      ['async function openThread', 'async function explain()'],
      ['async function explain()', 'async function clickCitation'],
      ['async function sendFollowup', 'function handlePassageClick'],
    ] as Array<[string, string]>) {
      expect(bodyBetween(s, start, end)).toMatch(/applyThreadDetail\(/);
    }
  });

  it('trimming is whitespace-only and never injects passage content', () => {
    const s = src();
    const start = s.indexOf('function trimMessageEdges');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = s.indexOf('Client Component', start);
    const body = s.slice(start, end === -1 ? undefined : end);
    expect(body).not.toMatch(/selectedText/);
    expect(body).not.toMatch(/pending\.text/);
    expect(body).not.toMatch(/anchorId/);
    // Render still shows provider content verbatim (no concatenation).
    expect(s).toMatch(/<div className="msg-ai">\{m\.content\}<\/div>/);
  });

  it('no spacer or min-height sits between question and answer in the DOM', () => {
    const s = src();
    expect(s).not.toMatch(/spacer/i);
    const c = css();
    const blocks = [...c.matchAll(/\.msg-exchange[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks).not.toMatch(/min-height:\s*[1-9]/);
  });
});

describe('exchange grouping: question and answer read as one unit', () => {
  it('user question plus following assistant answer share an exchange group', () => {
    const s = src();
    expect(s).toMatch(/msg-exchange/);
    expect(s).toMatch(/exchanges\.map/);
    // Each user message starts a new group; assistant messages join it.
    expect(s).toMatch(/if \(m\.role === 'user' \|\| !last\)/);
    // Message nodes keep their own ids, so exact-question targeting is intact.
    expect(s).toMatch(/data-message-id=\{m\.id\}/);
    expect(s).toMatch(/querySelector\(`\[data-message-id="\$\{targetId\}"\]`\)/);
  });

  it('internal user->assistant gap is smaller than the between-exchange separation', () => {
    const c = css();
    // Group separation first: distinct, larger rhythm between exchanges.
    expect(c).toMatch(/\.thread-card \.msg-exchange\s*\{\s*margin:\s*16px 0 0/);
    // Tight internal gaps: question sits shortly above its answer.
    expect(c).toMatch(/\.thread-card \.msg-exchange \.msg-user\s*\{\s*margin:\s*0 0 6px/);
    expect(c).toMatch(/\.thread-card \.msg-exchange \.msg-ai\s*\{\s*margin:\s*0 0 4px/);
  });

  it('grouping stays restrained: no cards, pills, gradients, or animation', () => {
    const c = css();
    const blocks = [...c.matchAll(/\.msg-exchange[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks).not.toMatch(/linear-gradient/i);
    expect(blocks).not.toMatch(/box-shadow/i);
    expect(blocks).not.toMatch(/border:/);
    expect(blocks).not.toMatch(/border-radius:\s*20px/);
    expect(blocks).not.toMatch(/animation/i);
    // Message typography untouched.
    expect(c).toMatch(/\.thread-card \.msg-ai\s*\{[^}]*line-height:\s*1\.65/);
    expect(c).toMatch(/\.thread-card \.msg-user\s*\{[^}]*line-height:\s*1\.6/);
  });
});
