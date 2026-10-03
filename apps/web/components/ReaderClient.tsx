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
    >
      {busy ? 'Explaining…' : 'Explain'}
    </button>
  );
}

/**
 * Client Component: the interactive reading surface.
 * - text selection → passage identification → Explain popover
 * - anchor/highlight persistence, passage thread panel, citation navigation
 * - reopen: highlights + threads reload from the Hono API
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
  const [messages, setMessages] = useState<Msg[]>([]);
  const [cites, setCites] = useState<Cite[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDto[]>([]);
  const [threadSel, setThreadSel] = useState('');
  const [followup, setFollowup] = useState('');
  const [citeFlash, setCiteFlash] = useState<{ passageId: string; start: number; end: number } | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const citeFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (citeFlashTimer.current) clearTimeout(citeFlashTimer.current);
  }, []);

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

  const scrollToPassage = useCallback((passageId: string) => {
    clearFlash();
    const el = docRef.current?.querySelector(`[data-passage-id="${passageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1700);
    }
  }, [clearFlash]);

  // Keep the latest thread message reachable in long threads.
  useEffect(() => {
    const el = threadScrollRef.current;
    if (el && openThreadId && messages.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, cites, openThreadId]);

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

  async function openThread(threadId: string, anchorSelectedText?: string) {
    setError('');
    try {
      const r = (await browserReq(`/api/threads/${threadId}`)) as {
        thread: { id: string }; messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
      };
      setOpenThreadId(threadId);
      setMessages(r.messages);
      setCites(r.citations ?? []);
      setEvidence(r.evidence ?? []);
      if (anchorSelectedText) setThreadSel(anchorSelectedText);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reopen thread');
    }
  }

  async function explain() {
    if (!pending || busy) return;
    setBusy(true);
    setError('');
    try {
      const anchor = (await browserReq('/api/anchors/resolve', {
        method: 'POST',
        body: JSON.stringify({
          documentVersionId: versionId,
          selectedText: pending.text,
          passageId: pending.passageId ?? undefined,
        }),
      })) as { anchorId: string; passageId: string };
      const result = (await browserReq('/api/threads/explain', {
        method: 'POST',
        body: JSON.stringify({ anchorId: anchor.anchorId }),
      })) as { threadId: string; citationIds: string[] };
      const detail = (await browserReq(`/api/threads/${result.threadId}`)) as {
        messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
      };
      setHighlights((prev) =>
        prev.some((h) => h.anchor_id === anchor.anchorId)
          ? prev
          : [...prev, {
            highlight_id: `local-${anchor.anchorId}`, anchor_id: anchor.anchorId,
            selected_text: pending.text, structural_path: '', passage_id: anchor.passageId,
            thread_id: result.threadId,
          }],
      );
      setPending(null);
      window.getSelection()?.removeAllRanges();
      setOpenThreadId(result.threadId);
      setMessages(detail.messages);
      setCites(detail.citations ?? []);
      setEvidence(detail.evidence ?? []);
      setThreadSel(pending.text);
      // Refresh authoritative highlight list (survives reload).
      browserReq(`/api/documents/${versionId}/highlights`)
        .then((r: any) => setHighlights(r.highlights))
        .catch(() => {});
    } catch (e) {
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
    setBusy(true);
    setError('');
    try {
      await browserReq(`/api/threads/${openThreadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: followup.trim() }),
      });
      const detail = (await browserReq(`/api/threads/${openThreadId}`)) as {
        messages: Msg[]; citations: Cite[]; evidence: EvidenceDto[];
      };
      setMessages(detail.messages);
      setCites(detail.citations ?? []);
      setEvidence(detail.evidence ?? []);
      setFollowup('');
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'message failed');
    } finally {
      setBusy(false);
    }
  }

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

  return (
    <div className="reader">
      <article className="doc" ref={docRef}>
        <h1>{title}</h1>
        {sourceUrl ? <p className="meta">{sourceUrl}</p> : null}
        {sections.map(({ section, heading, children }) => (
          <section key={section.id}>
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
              return (
                <p key={n.id} className="passage" data-passage-id={p?.id} data-node-path={n.structural_path}>
                  <MarkedPassageText
                    text={text}
                    selections={hls.map((h) => h.selected_text)}
                    flash={flash}
                  />
                </p>
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
      </article>

      <aside className="side">
        {error ? <p className="error">{error}</p> : null}

        {openThreadId ? (
          <div className="thread-card">
            <div className="thread-head">
              <div className="meta">Passage thread</div>
              {threadSel ? <div className="sel">“{threadSel.slice(0, 280)}”</div> : null}
            </div>
            <div
              className="thread-scroll"
              ref={threadScrollRef}
              tabIndex={0}
              role="log"
              aria-label="Passage thread messages"
              data-testid="thread-scroll"
            >
              {messages.map((m) => (
                <div key={m.id}>
                  {m.role === 'user' ? (
                    <div className="msg-user">{m.content}</div>
                  ) : (
                    <>
                      <div className="msg-ai">{m.content}</div>
                      <div className="meta">model: {m.model_id ?? 'unknown'}</div>
                      {renderCitations(citesByMessage.get(m.id) ?? [])}
                    </>
                  )}
                </div>
              ))}
              {ungroupedCites.length > 0 ? renderCitations(ungroupedCites) : null}
            </div>
            <div className="thread-foot">
              <form className="followup" onSubmit={sendFollowup}>
                <input
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                  placeholder="Ask a follow-up…"
                  aria-label="Follow-up question"
                />
                <button className="btn-ghost" disabled={busy} type="submit">Send</button>
              </form>
              <button className="btn-ghost" onClick={() => { setOpenThreadId(null); setMessages([]); setCites([]); setEvidence([]); }} type="button">
                Close thread
              </button>
            </div>
          </div>
        ) : (
          <div className="thread-card">
            <div className="meta">No thread open</div>
            <p style={{ fontSize: 14 }}>Select any sentence in the document — <b>Explain</b> appears immediately. The explanation stays attached to that exact passage.</p>
          </div>
        )}

        <div className="hl-list">
          <b>Highlights ({highlights.length})</b>
          {highlights.length === 0 ? <p className="meta">None yet.</p> : null}
          {highlights.map((h) => (
            <button
              key={h.highlight_id}
              onClick={() => {
                if (h.thread_id) openThread(h.thread_id, h.selected_text);
                else if (h.passage_id) scrollToPassage(h.passage_id);
              }}
              title="Reopen thread"
            >
              “{(h.selected_text ?? '').slice(0, 90)}”
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
