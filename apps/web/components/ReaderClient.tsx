'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browserApiBase, browserReq } from '@/lib/api';
import {
  EXPLAIN_FALLBACK_SIZE,
  clampExplainPosition,
  citationTargetPassageId,
} from '@/lib/explain-position';
import {
  buildMarkedSegments,
  findHighlightRanges,
  findSelectionRange,
  type TextRange,
} from '@/lib/highlight-render';

interface NodeDto { id: string; parent_id: string | null; node_type: string; structural_path: string; text: string }
interface PassageDto { id: string; node_id: string; structural_path: string; text: string }
interface HighlightDto {
  highlight_id: string; anchor_id: string; selected_text: string;
  structural_path: string; passage_id: string; thread_id: string | null;
}
interface Msg { id: string; role: string; content: string; model_id: string | null }
interface Cite { id: string; label: string; evidence_id: string }
interface EvidenceDto { id: string; thread_message_id: string; passage_id: string }

/**
 * Transient UI selection. The canonical anchor is { text, passageId } resolved
 * via /api/anchors/resolve — anchorX/anchorY are viewport client coords used
 * ONLY to place the Explain popover (never persisted as the anchor).
 */
interface PendingSel { text: string; passageId: string | null; anchorX: number; anchorY: number }

/**
 * Render passage text with EVERY persisted highlight slice wrapped in <mark>.
 * Ranges come from findHighlightRanges (exact-first, whitespace-tolerant);
 * an optional transient citation flash range is composed on top so the exact
 * cited selection is visible. Never falls back to whole-paragraph marking.
 */
function MarkedPassageText({
  text,
  selections,
  flash,
}: {
  text: string;
  selections: Array<string | null | undefined>;
  flash: TextRange | null;
}) {
  const segs = useMemo(
    () => buildMarkedSegments(text, findHighlightRanges(text, selections), flash),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, JSON.stringify(selections), flash?.start, flash?.end],
  );
  if (!segs.some((s) => s.marked || s.flash)) return <>{text}</>;
  return (
    <>
      {segs.map((s, i) => {
        const slice = text.slice(s.start, s.end);
        if (s.flash) return <mark key={i} className="cite-flash" data-cite-flash="1">{slice}</mark>;
        if (s.marked) return <mark key={i} className="hl" data-hl="1">{slice}</mark>;
        return <Fragment key={i}>{slice}</Fragment>;
      })}
    </>
  );
}

/**
 * Contextual Explain action. Fixed-positioned and always clamped inside the
 * browser viewport: flips above the selection when there is no room below,
 * shifts horizontally when near the right/left edge, and measures its own
 * dimensions instead of assuming a fixed position.
 */
function ExplainPopover({
  anchorX,
  anchorY,
  busy,
  onPick,
}: {
  anchorX: number;
  anchorY: number;
  busy: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState(EXPLAIN_FALLBACK_SIZE);
  const [viewport, setViewport] = useState({ width: 1024, height: 768 });

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setSize((prev) =>
        Math.abs(prev.width - rect.width) > 0.5 || Math.abs(prev.height - rect.height) > 0.5
          ? { width: rect.width, height: rect.height }
          : prev,
      );
    }
  });

  const pos = clampExplainPosition({ anchorX, anchorY }, size, viewport);

  return (
    <button
      ref={ref}
      type="button"
      className="explain-pop"
      data-testid="explain-pop"
      data-placed-above={pos.placedAbove ? 'true' : 'false'}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      disabled={busy}
      aria-label={busy ? 'Explaining selected passage' : 'Explain selected passage'}
    >
      {busy ? 'Explaining…' : 'Explain'}
    </button>
  );
}

/**
 * Display normalization: model output commonly starts/ends with blank lines,
 * which `white-space: pre-wrap` would otherwise render as dead vertical space
 * above/below the answer (measured ~48px top / ~71px bottom in real Chrome —
 * far larger than any CSS margin here, and unreachable via text-box-trim).
 * Stripping edge blank lines only keeps the question and answer visually
 * adjacent while preserving internal paragraph spacing exactly. Persistence
 * is untouched: ids, thread state, and server content stay as stored.
 */
function trimMessageEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}

/**
 * Consumes one Bhasya thread SSE stream (`chunk` text events, then exactly
 * one `done` event carrying the full result, or an `error` event). Calls
 * onChunk per text event with no scrolling, timers, or polling — the caller
 * decides all presentation. Throws on upstream errors, malformed endings,
 * or a non-streamable response (the caller then uses the complete/wait path).
 */
async function consumeThreadStream(
  response: Response,
  onChunk: (text: string) => void,
): Promise<any> {
  if (!response.ok || !response.body) {
    throw new Error(`stream unavailable: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      let event = '';
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const raw = line.slice(5).trimStart();
            if (event === 'chunk') {
              const text = (JSON.parse(raw) as { text?: unknown }).text;
              if (typeof text === 'string' && text.length > 0) onChunk(text);
            } else if (event === 'done') {
              return JSON.parse(raw);
            } else if (event === 'error') {
              const msg = (JSON.parse(raw) as { error?: unknown }).error;
              throw new Error(typeof msg === 'string' && msg.length > 0 ? msg : 'stream failed');
            }
          }
        }
        event = '';
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already closed */ }
  }
  throw new Error('stream ended without result');
}

/**
 * Client Component: the interactive reading surface.
 * - text selection → passage identification → Explain popover
 * - anchor/highlight persistence, passage thread panel, citation navigation
 * - reopen: highlights + threads reload from the Hono API
 *
 * Active context is explicit and keyed by thread:
 * openThreadId + activeAnchorId + activePassageId always move together so
 * passage A and passage B never share a panel, even when the provider
 * returns identical explanation text for both.
 *
 * Panel size is explicit UI state (panelMode compact/expanded), never
 * inferred from DOM measurements. Explain expands; intentional article
 * interaction compacts (thread preserved); close destroys the thread.
 */
export function ReaderClient(props: {
  versionId: string;
  title: string;
  sourceUrl: string;
  nodes: NodeDto[];
  passages: PassageDto[];
  initialHighlights: HighlightDto[];
  headingBySection: Record<string, string>;
  passageByNodeId: Record<string, string>;
}) {
  const { versionId, title, sourceUrl, nodes, passages } = props;
  const [highlights, setHighlights] = useState<HighlightDto[]>(props.initialHighlights);
  const [pending, setPending] = useState<PendingSel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [activePassageId, setActivePassageId] = useState<string | null>(null);
  /**
   * Explicit panel state, never inferred from DOM measurements.
   * - compact: reading-first sidebar; the article is the primary workspace.
   * - expanded: temporary second workspace (~half the desktop viewport)
   *   while the user actively interacts with a passage thread.
   * Explain is the explicit compact -> expanded transition; intentional
   * article interaction collapses expanded -> compact. Closing a thread is
   * a separate operation (destroys thread state) and is not the same thing
   * as compact mode (which preserves the thread).
   */
  const [panelMode, setPanelMode] = useState<'compact' | 'expanded'>('compact');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [cites, setCites] = useState<Cite[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDto[]>([]);
  const [threadSel, setThreadSel] = useState('');
  const [followup, setFollowup] = useState('');
  // Progressive assistant text while a stream is open. Rendered as-is (no
  // typing animation); cleared the moment the final message lands.
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [citeFlash, setCiteFlash] = useState<{ passageId: string; start: number; end: number } | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const openThreadRef = useRef<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  // Dedicated ref to the thread conversation scroll container. Follow-up
  // navigation scrolls THIS element only, never the whole page.
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const followupInputRef = useRef<HTMLInputElement>(null);
  // Exact newly created user-message id awaiting a one-shot reveal. Set from
  // the follow-up POST response, consumed once that node has rendered.
  // Null at all other times, so unrelated renders never force scrolling and
  // manual reading of older messages is never overridden.
  const pendingQuestionRef = useRef<string | null>(null);
  // Passage id awaiting a one-shot Explain reveal. Set once the anchor
  // resolves (authoritative passage, stable across the optimistic loading
  // state and the authoritative thread/messages replacement), consumed once
  // the newly created/activated passage thread has rendered. Null at all
  // other times so streaming chunks and unrelated renders never scroll.
  const pendingExplainRef = useRef<string | null>(null);
  const focusAfterSendRef = useRef(false);
  const citeFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (citeFlashTimer.current) clearTimeout(citeFlashTimer.current);
  }, []);

  useEffect(() => {
    openThreadRef.current = openThreadId;
  }, [openThreadId]);
  useEffect(() => () => {
    streamAbortRef.current?.abort();
  }, []);

  // Edge-trimmed preview of the in-flight assistant text. Same normalization
  // as persisted messages, so the streamed preview never flashes blank space
  // that the final message will not have.
  const streamPreview = useMemo(() => trimMessageEdges(streamText), [streamText]);

  const passageMap = useMemo(() => new Map(passages.map((p) => [p.id, p])), [passages]);
  const hlByPassage = useMemo(() => {
    const m = new Map<string, HighlightDto[]>();
    for (const h of highlights) {
      if (!m.has(h.passage_id)) m.set(h.passage_id, []);
      m.get(h.passage_id)!.push(h);
    }
    return m;
  }, [highlights]);

  // reading_session_started / ended at the semantic points.
  useEffect(() => {
    const base = browserApiBase();
    fetch(`${base}/api/reading-sessions/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentVersionId: versionId }),
    }).catch(() => {});
    return () => {
      fetch(`${base}/api/reading-sessions/end`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentVersionId: versionId }),
      }).catch(() => {});
    };
  }, [versionId]);

  const clearFlash = useCallback(() => {
    docRef.current?.querySelectorAll('.passage.flash').forEach((el) => el.classList.remove('flash'));
  }, []);

  // Shared passage reveal: centers by default so returns to reading context
  // (reopen, close, citations, highlight list) move the viewport as little as
  // possible. Callers with a different reading position pass it explicitly —
  // currently only the one-shot Explain navigation uses 'start'.
  const scrollToPassage = useCallback((passageId: string, block: 'center' | 'start' = 'center') => {
    clearFlash();
    const el = docRef.current?.querySelector(`[data-passage-id="${passageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1700);
    }
  }, [clearFlash]);

  // Intentional article interaction collapses expanded -> compact WITHOUT
  // touching thread state (thread, passage, messages, citations all stay).
  // Scoped to the article surface only — never a document-level listener —
  // and guarded so thread-adjacent clicks never collapse: highlight marks
  // (which reopen threads), inline thread controls, selection controls, and
  // an in-progress text selection (the start of an Explain flow).
  const handleArticleClick = useCallback((e: React.MouseEvent) => {
    if (!openThreadId) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('mark.hl, .passage-threads, .passage-thread-link, .explain-pop, button, a')) return;
    if (typeof window !== 'undefined' && (window.getSelection()?.toString().trim() ?? '') !== '') return;
    setPanelMode('compact');
  }, [openThreadId]);

  // Compact reopen: clicking the compact thread surface (body/content)
  // re-expands the SAME thread. Nothing is refetched, cleared, or toggled:
  // openThreadId, passage, messages, citations, and scroll position all stay
  // exactly as they were. Controls keep their normal actions (buttons,
  // links, inputs, and the composer are excluded), and closeThread remains
  // the only path that destroys thread state. Scoped to the thread card —
  // never a document-level listener — so article selection is unaffected.
  const handleCompactExpand = useCallback((e: React.MouseEvent) => {
    if (panelMode !== 'compact' || !openThreadId) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('button, a, input, form, select, textarea')) return;
    setPanelMode('expanded');
  }, [panelMode, openThreadId]);

  // One-shot follow-up navigation: after the exact newly created user
  // question has rendered, scroll the conversation container so that
  // question sits near the upper part of the viewport with the forthcoming
  // assistant answer directly beneath it. Runs only while a pending target
  // exists, then clears it — never snaps to the absolute bottom and never
  // overrides manual reading. DOM/state-synchronized via useLayoutEffect
  // (no arbitrary timeouts), and only the conversation container scrolls.
  useLayoutEffect(() => {
    const targetId = pendingQuestionRef.current;
    if (!targetId || !openThreadId) return;
    const container = threadScrollRef.current;
    if (!container) return;
    const node = container.querySelector(`[data-message-id="${targetId}"]`);
    if (!node || !(node instanceof HTMLElement)) return;
    pendingQuestionRef.current = null;
    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const placeAt = container.scrollTop + (nodeRect.top - containerRect.top)
      - Math.round(container.clientHeight * 0.2);
    container.scrollTop = Math.max(0, placeAt);
  }, [messages, openThreadId]);

  // One-shot Explain navigation: after an Explain request creates/activates
  // its passage thread, bring that active passage to the top of the reading
  // viewport (block 'start', honoring the passage scroll-margin) so a
  // selection near the bottom lands fully in the useful reading area with
  // its thread context beneath it, instead of stopping halfway up. Runs only
  // while a pending Explain target exists and the authoritative thread has
  // rendered, then clears it — never per streamed chunk and never overriding
  // manual reading. DOM/state-synchronized via useLayoutEffect (no timers),
  // and reuses the existing passage target/ref structure.
  useLayoutEffect(() => {
    const passageId = pendingExplainRef.current;
    if (!passageId || !openThreadId) return;
    // Only the currently active passage/thread navigates; a superseded
    // Explain keeps waiting for its own activation instead of scrolling stale.
    if (activePassageId !== passageId) return;
    // Authoritative thread DOM must exist (thread card hosts the scroll
    // container); otherwise wait for the next state update — do not clear.
    if (!threadScrollRef.current) return;
    const passageEl = docRef.current?.querySelector(`[data-passage-id="${passageId}"]`);
    if (!passageEl) return;
    pendingExplainRef.current = null;
    scrollToPassage(passageId, 'start');
  }, [messages, highlights, openThreadId, activePassageId]);

  // Return keyboard focus to the composer after a follow-up round-trips,
  // once the input is enabled again. State-driven, no timeouts.
  useEffect(() => {
    if (!busy && focusAfterSendRef.current) {
      focusAfterSendRef.current = false;
      followupInputRef.current?.focus();
    }
  }, [busy]);

  // Selection → passage identification → Explain popover appears immediately.
  // Stores viewport client coords only; the canonical anchor stays
  // { selectedText, passageId } and is resolved server-side.
  useEffect(() => {
    const readSelection = (fallbackX?: number, fallbackY?: number) => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!text || text.length < 2) { setPending(null); return; }
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      let passageEl = (range?.startContainer as Node)?.parentElement as HTMLElement | null;
      passageEl = passageEl?.closest?.('[data-passage-id]') as HTMLElement | null;
      if (!passageEl) { setPending(null); return; }
      const rect = range?.getBoundingClientRect();
      // Viewport (client) coordinates — no scroll offsets (popover is fixed).
      const anchorX = rect && rect.width >= 0 ? rect.left : (fallbackX ?? window.innerWidth / 2);
      const anchorY = rect && rect.width >= 0 ? rect.bottom : (fallbackY ?? window.innerHeight / 2);
      setPending({
        text,
        passageId: passageEl.getAttribute('data-passage-id'),
        anchorX,
        anchorY,
      });
    };
    const onUp = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.side') || target.closest?.('.explain-pop')) return;
      readSelection(e.clientX, e.clientY);
    };
    const onTouchEnd = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.side') || target.closest?.('.explain-pop')) return;
      // Let the selection settle before reading it.
      setTimeout(() => readSelection(), 0);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPending(null); return; }
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.side') || target?.closest?.('.explain-pop')) return;
      // Keyboard-driven selection (e.g. Shift+arrows): re-read selection.
      if (e.shiftKey || e.key.startsWith('Arrow')) readSelection();
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  function clearThreadState() {
    // An in-flight stream belongs to the closing thread: abort it so a late
    // completion can never repopulate cleared state.
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    pendingExplainRef.current = null;
    setStreamText('');
    setStreaming(false);
    setOpenThreadId(null);
    setActiveAnchorId(null);
    setActivePassageId(null);
    setMessages([]);
    setCites([]);
    setEvidence([]);
    setThreadSel('');
    setFollowup('');
  }

  // Closing DESTROYS thread state — distinct from compact mode, which
  // preserves the thread. With no open thread the panel returns to baseline.
  function closeThread(returnToReading: boolean) {
    const passageId = activePassageId;
    clearThreadState();
    setPanelMode('compact');
    if (returnToReading && passageId) {
      // Closing returns naturally to reading: bring the passage back into view.
      setTimeout(() => scrollToPassage(passageId), 30);
    }
  }

  // Single ingestion point for thread detail responses: message contents
  // are edge-trimmed for display only (see trimMessageEdges). Ids, roles,
  // model ids, citations, and evidence pass through untouched.
  const applyThreadDetail = useCallback((detail: {
    messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
  }) => {
    setMessages(detail.messages.map((m) => ({ ...m, content: trimMessageEdges(m.content) })));
    setCites(detail.citations ?? []);
    setEvidence(detail.evidence ?? []);
  }, []);

  async function openThread(threadId: string, anchorSelectedText?: string) {
    setError('');
    // Resolve passage context from the persisted highlight before fetching so
    // the panel is keyed correctly even before messages arrive.
    const hl = highlights.find((h) => h.thread_id === threadId) ?? null;
    const contextPassageId = hl?.passage_id ?? activePassageId;
    const contextAnchorId = hl?.anchor_id ?? null;
    const contextText = anchorSelectedText ?? hl?.selected_text ?? '';
    if (contextPassageId) setActivePassageId(contextPassageId);
    if (contextAnchorId) setActiveAnchorId(contextAnchorId);
    if (contextText) setThreadSel(contextText);
    try {
      const r = (await browserReq(`/api/threads/${threadId}`)) as {
        thread: { id: string }; messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
      };
      setOpenThreadId(threadId);
      applyThreadDetail(r);
      // Explicitly entering a thread makes it the active workspace.
      setPanelMode('expanded');
      if (anchorSelectedText) setThreadSel(anchorSelectedText);
      else if (hl?.selected_text) setThreadSel(hl.selected_text);
      // Reopening returns to its passage context.
      if (contextPassageId) scrollToPassage(contextPassageId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reopen thread');
    }
  }

  async function explain() {
    if (!pending || busy) return;
    const selectedText = pending.text;
    const selectedPassageId = pending.passageId;
    setBusy(true);
    setError('');
    // Shared completion: identical thread state whether the answer streamed
    // progressively or arrived via the complete/wait fallback.
    const finishExplain = async (anchor: { anchorId: string; passageId: string }, threadId: string) => {
      const detail = (await browserReq(`/api/threads/${threadId}`)) as {
        messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
      };
      setHighlights((prev) =>
        prev.some((h) => h.anchor_id === anchor.anchorId)
          ? prev
          : [...prev, {
            highlight_id: `local-${anchor.anchorId}`, anchor_id: anchor.anchorId,
            selected_text: selectedText, structural_path: '', passage_id: anchor.passageId,
            thread_id: threadId,
          }],
      );
      setPending(null);
      window.getSelection()?.removeAllRanges();
      // Key the panel to this exact anchor/passage/thread triple. The passage
      // excerpt is shown verbatim so two passages stay distinct contexts even
      // when the provider returns identical explanation text.
      setOpenThreadId(threadId);
      setActiveAnchorId(anchor.anchorId);
      setActivePassageId(anchor.passageId ?? selectedPassageId);
      applyThreadDetail(detail);
      // Explain is the explicit compact -> expanded transition.
      setPanelMode('expanded');
      setThreadSel(selectedText);
      // Refresh authoritative highlight list (survives reload).
      browserReq(`/api/documents/${versionId}/highlights`)
        .then((r: any) => setHighlights(r.highlights))
        .catch(() => {});
    };
    try {
      const anchor = (await browserReq('/api/anchors/resolve', {
        method: 'POST',
        body: JSON.stringify({
          documentVersionId: versionId,
          selectedText: pending.text,
          passageId: pending.passageId ?? undefined,
        }),
      })) as { anchorId: string; passageId: string };
      // Arm the one-shot Explain navigation to the authoritative passage.
      // Stable across the optimistic loading state and the authoritative
      // thread/messages replacement; cleared on abort/failure so no stale
      // target ever navigates.
      const explainPassageId = anchor.passageId ?? selectedPassageId;
      if (explainPassageId) pendingExplainRef.current = explainPassageId;
      // Prefer the streaming path so first useful text appears as generated.
      // Falls back to the complete/wait path when streaming is unavailable.
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const isCurrent = () => streamAbortRef.current === ctrl && !ctrl.signal.aborted;
      let receivedAny = false;
      try {
        setStreaming(true);
        setStreamText('');
        const res = await fetch(`${browserApiBase()}/api/threads/explain/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ anchorId: anchor.anchorId }),
          signal: ctrl.signal,
        });
        const done = (await consumeThreadStream(res, (t) => {
          receivedAny = true;
          // No scrolling here: the loading state already anchors the panel,
          // and the one-shot navigation reveals the finished thread.
          setStreamText((prev) => prev + t);
        })) as { threadId: string };
        if (!isCurrent()) {
          pendingExplainRef.current = null;
          return;
        }
        streamAbortRef.current = null;
        setStreamText('');
        setStreaming(false);
        await finishExplain(anchor, String(done.threadId));
      } catch (streamErr) {
        if (!isCurrent()) {
          pendingExplainRef.current = null;
          return;
        }
        streamAbortRef.current = null;
        setStreamText('');
        setStreaming(false);
        if (receivedAny) throw streamErr;
        // Complete/wait fallback: same result, shown all at once.
        const result = (await browserReq('/api/threads/explain', {
          method: 'POST',
          body: JSON.stringify({ anchorId: anchor.anchorId }),
        })) as { threadId: string; citationIds: string[] };
        await finishExplain(anchor, result.threadId);
      }
    } catch (e) {
      // No real thread exists here: never leave a misleading scroll target.
      pendingExplainRef.current = null;
      setError(e instanceof Error ? e.message : 'explanation failed');
    } finally {
      setBusy(false);
    }
  }

  async function clickCitation(citeId: string) {
    try {
      const r = (await browserReq(`/api/citations/${citeId}`)) as {
        citation: { passage_id: string; anchor_id?: string; passage_text?: string };
      };
      const passageId = citationTargetPassageId(r.citation);
      if (!passageId) throw new Error('citation has no passage');
      scrollToPassage(passageId);
      // Resolve the exact cited selection via the citation's own anchor:
      // highlights carry the persisted selected_text per anchor_id, so the
      // flash lands on the exact text that produced this explanation.
      if (citeFlashTimer.current) clearTimeout(citeFlashTimer.current);
      const anchorId = typeof r.citation.anchor_id === 'string' ? r.citation.anchor_id : null;
      const selText = anchorId
        ? (highlights.find((h) => h.anchor_id === anchorId)?.selected_text ?? null)
        : null;
      const passageText = typeof r.citation.passage_text === 'string' ? r.citation.passage_text : null;
      const range = passageText && selText ? findSelectionRange(passageText, selText) : null;
      if (range) {
        setCiteFlash({ passageId, start: range.start, end: range.end });
        // Bring the exact cited slice into view (passage elements can be long).
        setTimeout(() => {
          docRef.current?.querySelector('[data-cite-flash="1"]')
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
        citeFlashTimer.current = setTimeout(() => setCiteFlash(null), 2600);
      } else {
        setCiteFlash(null);
      }
      browserReq(`/api/citations/${citeId}/clicked`, { method: 'POST' }).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'citation did not resolve');
    }
  }

  async function sendFollowup(e: React.FormEvent) {
    e.preventDefault();
    if (!openThreadId || !followup.trim() || busy) return;
    const threadId = openThreadId;
    const content = followup.trim();
    // The exact question appears immediately with a client-local id; the
    // one-shot navigation effect reveals THAT node, and the authoritative
    // server message replaces it below without moving the user.
    const tempId = `pending-${Date.now()}`;
    pendingQuestionRef.current = tempId;
    focusAfterSendRef.current = true;
    setBusy(true);
    setError('');
    setFollowup('');
    setMessages((prev) => [...prev, { id: tempId, role: 'user', content, model_id: null }]);
    // Shared completion: reconcile with authoritative server state, then
    // anchor the conversation to the real persisted question.
    const finishFollowup = async (userMessageId: string) => {
      const detail = (await browserReq(`/api/threads/${threadId}`)) as {
        messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
      };
      if (openThreadRef.current !== threadId) return;
      applyThreadDetail(detail);
      pendingQuestionRef.current = userMessageId;
    };
    try {
      // Prefer streaming: the assistant answer accumulates below the exact
      // question as it is generated. Falls back to the complete/wait path
      // when streaming is unavailable before any chunk arrives.
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const isCurrent = () => streamAbortRef.current === ctrl && !ctrl.signal.aborted;
      let receivedAny = false;
      try {
        setStreaming(true);
        setStreamText('');
        const res = await fetch(`${browserApiBase()}/api/threads/${threadId}/messages/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
          signal: ctrl.signal,
        });
        const done = (await consumeThreadStream(res, (t) => {
          receivedAny = true;
          // No scrolling per chunk: the question stays anchored where the
          // one-shot navigation placed it; text grows beneath it.
          setStreamText((prev) => prev + t);
        })) as { userMessageId: string };
        if (!isCurrent()) return;
        streamAbortRef.current = null;
        setStreamText('');
        setStreaming(false);
        await finishFollowup(String(done.userMessageId));
      } catch (streamErr) {
        if (!isCurrent()) return;
        streamAbortRef.current = null;
        setStreamText('');
        setStreaming(false);
        if (receivedAny) {
          // Partial answer was never persisted server-side: reconcile to the
          // persisted question, then surface the interruption.
          await finishFollowup(tempId).catch(() => {});
          throw streamErr;
        }
        // Complete/wait fallback: same result, shown all at once.
        const posted = (await browserReq(`/api/threads/${threadId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content }),
        })) as { userMessageId: string };
        if (posted?.userMessageId) await finishFollowup(String(posted.userMessageId));
      }
    } catch (e2) {
      pendingQuestionRef.current = null;
      focusAfterSendRef.current = false;
      setError(e2 instanceof Error ? e2.message : 'message failed');
    } finally {
      setBusy(false);
    }
  }

  function handlePassageClick(passageId: string) {
    return (e: React.MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const mark = target?.closest?.('mark.hl') as HTMLElement | null;
      if (!mark) return;
      const slice = mark.textContent ?? '';
      const candidates = hlByPassage.get(passageId) ?? [];
      const match =
        candidates.find((h) => h.selected_text === slice) ??
        candidates.find((h) => h.selected_text && slice.includes(h.selected_text.slice(0, 24))) ??
        candidates.find((h) => h.thread_id) ??
        null;
      if (match?.thread_id) {
        e.preventDefault();
        void openThread(match.thread_id, match.selected_text);
      } else if (match && match.passage_id) {
        scrollToPassage(match.passage_id);
      }
    };
  }

  // Id of the newest user question, so it stays easy to spot with a
  // restrained marker. Derived from state, no extra network or DOM reads.
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') return messages[i].id;
    }
    return null;
  }, [messages]);

  // Exchange grouping: each user question plus its immediately following
  // assistant message(s) render as one continuous exchange with a small
  // internal gap; separate exchanges keep a larger separation. Grouping is
  // purely presentational — message nodes keep their own data-message-id so
  // exact-question scroll targeting is unchanged.
  interface Exchange { key: string; messages: Msg[] }
  const exchanges: Exchange[] = useMemo(() => {
    const groups: Exchange[] = [];
    for (const m of messages) {
      const last = groups[groups.length - 1];
      if (m.role === 'user' || !last) groups.push({ key: m.id, messages: [m] });
      else last.messages.push(m);
    }
    return groups;
  }, [messages]);

  // Citations grouped by assistant message via Evidence:
  // Thread Message → Evidence → Passage → Document Version.
  const citesByMessage = useMemo(() => {
    const map = new Map<string, Cite[]>();
    if (cites.length === 0) return map;
    if (evidence.length === 0) return map; // caller falls back to thread-level list
    const evById = new Map(evidence.map((e) => [e.id, e]));
    for (const c of cites) {
      const ev = evById.get(c.evidence_id);
      if (!ev) continue;
      if (!map.has(ev.thread_message_id)) map.set(ev.thread_message_id, []);
      map.get(ev.thread_message_id)!.push(c);
    }
    return map;
  }, [cites, evidence]);
  const ungroupedCites = useMemo(() => {
    if (cites.length === 0) return [];
    if (evidence.length === 0) return cites; // legacy/fallback: show at thread level
    const grouped = new Set<string>();
    for (const list of citesByMessage.values()) for (const c of list) grouped.add(c.id);
    return cites.filter((c) => !grouped.has(c.id));
  }, [cites, evidence, citesByMessage]);

  function renderCitations(list: Cite[]) {
    if (list.length === 0) return null;
    return (
      <div className="cite-block" data-testid="citation-block">
        <div className="cite-heading">Source evidence — select to view in the document</div>
        <div className="cite-list">
          {list.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className="cite-btn cite-visible"
              data-testid="citation-link"
              data-citation-id={c.id}
              onClick={() => clickCitation(c.id)}
              title="Focus the cited passage in the reader"
              aria-label={`${c.label || `Source ${i + 1}`}: focus cited passage in reader`}
            >
              <span aria-hidden="true">§ </span>{c.label || `Source ${i + 1}`} — view passage
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Render canonical tree order: sections with headings + paragraphs.
  const sections = useMemo(() => {
    const secs = nodes.filter((n) => n.node_type === 'section');
    const kids = new Map<string, NodeDto[]>();
    for (const n of nodes) {
      if (!n.parent_id) continue;
      if (!kids.has(n.parent_id)) kids.set(n.parent_id, []);
      kids.get(n.parent_id)!.push(n);
    }
    return secs.map((s) => ({
      section: s,
      heading: props.headingBySection[s.id] ?? '',
      children: (kids.get(s.id) ?? []).filter((k) => k.node_type !== 'section'),
    }));
  }, [nodes, props.headingBySection]);

  const activePassage = activePassageId ? passageMap.get(activePassageId) ?? null : null;

  return (
    <div
      className={panelMode === 'expanded' ? 'reader reader-expanded' : 'reader'}
      data-panel={panelMode}
    >
      <article className="doc" ref={docRef} aria-label="Document reading view" onClick={handleArticleClick}>
        <div className="doc-inner">
          <header className="doc-header">
            <h1>{title}</h1>
            {sourceUrl ? <p className="meta doc-source">{sourceUrl}</p> : null}
          </header>
          {sections.map(({ section, heading, children }) => (
            <section key={section.id} aria-label={heading || 'Document section'}>
              {heading ? <h2>{heading}</h2> : null}
              {children.map((n) => {
                const p = props.passageByNodeId[n.id] ? passageMap.get(props.passageByNodeId[n.id]) : undefined;
                if (n.node_type === 'heading') return null;
                const text = p?.text ?? n.text;
                if (!text) return null;
                const hls = p ? (hlByPassage.get(p.id) ?? []) : [];
                const flash = p && citeFlash && citeFlash.passageId === p.id
                  ? { start: citeFlash.start, end: citeFlash.end }
                  : null;
                const isActive = p ? p.id === activePassageId : false;
                const threadCount = hls.filter((h) => h.thread_id).length;
                return (
                  <div key={n.id} className="passage-wrap">
                    <p
                      className={isActive ? 'passage active' : 'passage'}
                      data-passage-id={p?.id}
                      data-active={isActive ? 'true' : 'false'}
                      data-node-path={n.structural_path}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={p ? handlePassageClick(p.id) : undefined}
                    >
                      <MarkedPassageText
                        text={text}
                        selections={hls.map((h) => h.selected_text)}
                        flash={flash}
                      />
                    </p>
                    {p && threadCount > 0 ? (
                      <div className="passage-threads" data-testid="passage-threads" data-passage-id={p.id}>
                        <span className="passage-threads-label">
                          {threadCount === 1 ? '1 thread in this passage' : `${threadCount} threads in this passage`}
                        </span>
                        {hls.filter((h) => h.thread_id).slice(0, 2).map((h) => (
                          <button
                            key={h.highlight_id}
                            type="button"
                            className="passage-thread-link"
                            data-testid="passage-thread-link"
                            data-thread-id={h.thread_id}
                            data-anchor-id={h.anchor_id}
                            onClick={() => openThread(h.thread_id as string, h.selected_text)}
                            aria-label={`Open thread for passage excerpt ${(h.selected_text ?? '').slice(0, 60)}`}
                          >
                            Open thread
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
          {pending ? (
            <ExplainPopover
              anchorX={pending.anchorX}
              anchorY={pending.anchorY}
              busy={busy}
              onPick={explain}
            />
          ) : null}
        </div>
      </article>

      <aside className="side" aria-label="Passage threads and highlights">
        {error ? <p className="error" role="alert">{error}</p> : null}

        {openThreadId ? (
          <div
            className="thread-card"
            onClick={handleCompactExpand}
            key={openThreadId}
            data-thread-id={openThreadId}
            data-passage-id={activePassageId ?? ''}
            data-anchor-id={activeAnchorId ?? ''}
          >
            <div className="thread-head">
              <div className="meta">Passage thread</div>
              {threadSel ? <div className="sel">“{threadSel.slice(0, 280)}”</div> : null}
              <div className="thread-context">
                <button
                  type="button"
                  className="btn-ghost thread-context-btn"
                  data-testid="view-passage-btn"
                  onClick={() => { if (activePassageId) scrollToPassage(activePassageId); }}
                  disabled={!activePassageId}
                >
                  View passage in document
                </button>
              </div>
            </div>
            <div
              className="thread-scroll"
              ref={threadScrollRef}
              tabIndex={0}
              role="log"
              aria-label="Passage thread messages"
              data-testid="thread-scroll"
            >
              {exchanges.map((ex, exIdx) => (
                <div key={ex.key} className="msg-exchange">
                  {ex.messages.map((m) => (
                    <div key={m.id} data-message-id={m.id}>
                      {m.role === 'user' ? (
                        <div
                          className={m.id === lastUserId ? 'msg-user msg-user-latest' : 'msg-user'}
                          data-latest={m.id === lastUserId ? 'true' : undefined}
                        >{m.content}</div>
                      ) : (
                        <>
                          <div className="msg-ai">{m.content}</div>
                          <div className="meta">model: {m.model_id ?? 'unknown'}</div>
                          {renderCitations(citesByMessage.get(m.id) ?? [])}
                        </>
                      )}
                    </div>
                  ))}
                  {streaming && streamPreview && exIdx === exchanges.length - 1 ? (
                    <div className="msg-ai" data-streaming="true">{streamPreview}</div>
                  ) : null}
                </div>
              ))}
              {ungroupedCites.length > 0 ? renderCitations(ungroupedCites) : null}
              {busy ? (
                <div className="thread-loading" data-testid="thread-loading" aria-live="polite">
                  <div className="skeleton skeleton-line" />
                  <div className="skeleton skeleton-line short" />
                  <div className="skeleton skeleton-line" />
                </div>
              ) : null}
            </div>
            <div className="thread-foot">
              <form className="followup" onSubmit={sendFollowup}>
                <input
                  ref={followupInputRef}
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                  placeholder="Ask a follow-up…"
                  aria-label="Follow-up question"
                  disabled={busy}
                />
                <button className="btn-ghost" disabled={busy || !followup.trim()} type="submit">Send</button>
              </form>
              <div className="thread-actions">
                <button className="btn-ghost" onClick={() => closeThread(true)} type="button">
                  Close and return to reading
                </button>
              </div>
            </div>
          </div>
        ) : busy ? (
          <div className="thread-card" data-testid="thread-loading-card" aria-live="polite">
            <div className="thread-head">
              <div className="meta">Preparing explanation</div>
              {pending ? <div className="sel">“{pending.text.slice(0, 280)}”</div> : null}
            </div>
            {streamPreview ? (
              <div className="msg-ai" data-streaming="true">{streamPreview}</div>
            ) : null}
            <div className="thread-loading" data-testid="thread-loading">
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
            </div>
          </div>
        ) : (
          <div className="thread-card">
            <div className="meta">No thread open</div>
            <p style={{ fontSize: 14 }}>Select any sentence in the document — <b>Explain</b> appears near your selection. The explanation stays attached to that exact passage.</p>
            {activePassage && threadSel ? (
              <div className="thread-context">
                <div className="sel">“{threadSel.slice(0, 280)}”</div>
              </div>
            ) : null}
          </div>
        )}

        <div className="hl-list" aria-label="Highlights and threads">
          <b>Highlights ({highlights.length})</b>
          {highlights.length === 0 ? <p className="meta">None yet.</p> : null}
          {highlights.map((h) => {
            const isActiveThread = h.thread_id != null && h.thread_id === openThreadId;
            return (
              <button
                key={h.highlight_id}
                data-testid="highlight-link"
                data-thread-id={h.thread_id ?? ''}
                data-passage-id={h.passage_id}
                data-anchor-id={h.anchor_id}
                data-active={isActiveThread ? 'true' : 'false'}
                className={isActiveThread ? 'hl-item active' : 'hl-item'}
                onClick={() => {
                  if (h.thread_id) openThread(h.thread_id, h.selected_text);
                  else if (h.passage_id) scrollToPassage(h.passage_id);
                }}
                title={h.thread_id ? 'Reopen thread' : 'View passage'}
                aria-current={isActiveThread ? 'true' : undefined}
              >
                “{(h.selected_text ?? '').slice(0, 90)}”
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
