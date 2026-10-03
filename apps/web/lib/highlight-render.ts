/**
 * Highlight rendering contract (pure, DOM-free so it can be unit-tested).
 *
 * The canonical anchor remains server-side:
 *   document_version_id / node_id / selected_text / offsets / text_hash /
 *   structural_path / context_fingerprint / format-specific locator.
 * Screen coordinates are never used here.
 *
 * Rendering rules:
 * - EVERY persisted highlight for a passage renders its exact selected slice
 *   as <mark> (never the whole paragraph as a fallback).
 * - Matching is exact-first (`indexOf`), then whitespace-tolerant (browser
 *   selections may carry newlines/runs of spaces where the canonical passage
 *   text has single spaces). The tolerant pass reports offsets into the
 *   ORIGINAL text so the mark covers the right slice.
 * - Overlapping selections collapse deterministically (earliest start wins,
 *   longest wins ties) so output never nests or duplicates marks.
 * - No match renders unmarked text — never a whole-paragraph highlight.
 */

export interface TextRange {
  start: number;
  end: number;
}

export interface MarkedSegment extends TextRange {
  /** Covered by a persisted highlight. */
  marked: boolean;
  /** Covered by the transient citation flash. */
  flash: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate one selection inside passage text. Returns offsets into the ORIGINAL
 * text, or null when the selection cannot be found.
 */
export function findSelectionRange(text: string, selected: string | null | undefined): TextRange | null {
  const sel = (selected ?? '').trim();
  if (!sel || !text) return null;
  const exact = text.indexOf(sel);
  if (exact >= 0) return { start: exact, end: exact + sel.length };
  // Whitespace-tolerant: ordered words joined by \s+ (covers \n, tabs,
  // double spaces, nbsp). Reports offsets in the original text.
  const words = sel.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  // Bound the pattern so pathological selections cannot blow up matching.
  const capped = words.slice(0, 60);
  let re: RegExp;
  try {
    re = new RegExp(capped.map(escapeRegExp).join('\\s+'));
  } catch {
    return null;
  }
  const m = re.exec(text);
  if (!m || !m[0]) return null;
  const start = m.index;
  return { start, end: start + m[0].length };
}

/** Locate every selection; returns sorted, non-overlapping ranges. */
export function findHighlightRanges(text: string, selections: Array<string | null | undefined>): TextRange[] {
  const found: TextRange[] = [];
  for (const s of selections) {
    const r = findSelectionRange(text, s);
    if (r && r.end > r.start) found.push(r);
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TextRange[] = [];
  for (const r of found) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) continue; // overlap: earliest/longest wins
    out.push(r);
  }
  return out;
}

function clampRange(r: TextRange, len: number): TextRange | null {
  const start = Math.max(0, Math.min(r.start, len));
  const end = Math.max(0, Math.min(r.end, len));
  return end > start ? { start, end } : null;
}

/**
 * Split text into segments for rendering, composing persisted highlight
 * ranges with an optional transient citation flash range.
 */
export function buildMarkedSegments(
  text: string,
  hlRanges: TextRange[],
  flashRange: TextRange | null,
): MarkedSegment[] {
  const len = text.length;
  const hls = hlRanges
    .map((r) => clampRange(r, len))
    .filter((r): r is TextRange => r !== null)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const flash = flashRange ? clampRange(flashRange, len) : null;

  const cuts = new Set<number>([0, len]);
  for (const r of hls) { cuts.add(r.start); cuts.add(r.end); }
  if (flash) { cuts.add(flash.start); cuts.add(flash.end); }
  const pts = [...cuts].sort((a, b) => a - b);

  const segs: MarkedSegment[] = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const start = pts[i];
    const end = pts[i + 1];
    if (end <= start) continue;
    const marked = hls.some((r) => start >= r.start && end <= r.end);
    const fl = flash !== null && start >= flash.start && end <= flash.end;
    segs.push({ start, end, marked, flash: fl });
  }
  return segs;
}
