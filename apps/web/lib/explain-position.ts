/**
 * Viewport-clamped positioning for the contextual Explain action.
 *
 * The canonical anchor representation is { selectedText, passageId } (resolved
 * via /api/anchors/resolve). Screen coordinates are NEVER the canonical anchor —
 * they are only a transient UI hint (viewport client coords from the selection
 * rect) used to place the popover. This module contains the pure clamping math
 * so it can be unit-tested without a DOM.
 */

export interface ExplainAnchorPoint {
  /** Viewport client X of the selection (e.g. range rect left). */
  anchorX: number;
  /** Viewport client Y of the selection bottom (e.g. range rect bottom). */
  anchorY: number;
}

export interface ExplainPopoverSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ClampedExplainPosition {
  left: number;
  top: number;
  placedAbove: boolean;
}

export const EXPLAIN_GAP = 8;
export const EXPLAIN_MARGIN = 8;
/** Fallback size before the popover measures itself. */
export const EXPLAIN_FALLBACK_SIZE: ExplainPopoverSize = { width: 140, height: 40 };

/**
 * Calculate a fully-visible fixed position for the Explain action.
 *
 * - Uses viewport (client) coordinates; caller must NOT add scroll offsets
 *   because the popover is position:fixed.
 * - Places below the selection when there is room, otherwise above.
 * - Shifts horizontally into the viewport and clamps to `margin`.
 * - Accounts for the popover's own dimensions.
 */
export function clampExplainPosition(
  anchor: ExplainAnchorPoint,
  popover: ExplainPopoverSize,
  viewport: ViewportSize,
  gap = EXPLAIN_GAP,
  margin = EXPLAIN_MARGIN,
): ClampedExplainPosition {
  const vw = Math.max(0, viewport.width);
  const vh = Math.max(0, viewport.height);
  const pw = Math.max(0, popover.width);
  const ph = Math.max(0, popover.height);

  // Horizontal: shift into viewport. If the popover is wider than the
  // viewport, pin to margin (CSS max-width keeps it usable).
  let left: number;
  if (pw + margin * 2 >= vw) {
    left = margin;
  } else {
    left = Math.min(Math.max(anchor.anchorX, margin), vw - pw - margin);
  }

  // Vertical: prefer below, flip above when insufficient space below.
  const belowTop = anchor.anchorY + gap;
  const aboveTop = anchor.anchorY - gap - ph;
  const fitsBelow = belowTop + ph + margin <= vh;
  const fitsAbove = aboveTop - margin >= 0;
  let top: number;
  let placedAbove = false;
  if (fitsBelow) {
    top = belowTop;
  } else if (fitsAbove) {
    top = aboveTop;
    placedAbove = true;
  } else {
    // Neither fits cleanly (very short viewport): prefer the side with more
    // space, then clamp so the popover stays fully visible when possible.
    const spaceBelow = vh - belowTop - margin;
    const spaceAbove = aboveTop - margin;
    if (spaceAbove > spaceBelow) {
      top = Math.max(margin, Math.min(aboveTop, Math.max(margin, vh - ph - margin)));
      placedAbove = true;
    } else {
      top = Math.max(margin, Math.min(belowTop, Math.max(margin, vh - ph - margin)));
    }
  }

  // Final safety clamp (handles tiny viewports where ph > vh).
  top = Math.max(margin, Math.min(top, Math.max(margin, vh - ph - margin)));
  left = Math.max(margin, Math.min(left, Math.max(margin, vw - pw - margin)));

  return { left, top, placedAbove };
}

/**
 * Extract the passage id a citation should navigate to.
 * Preserves the version-aware model: Thread Message → Evidence → Passage →
 * Document Version. The payload comes from GET /api/citations/:id which joins
 * citations → evidence → passages.
 */
export function citationTargetPassageId(
  citation: { passage_id?: unknown } | null | undefined,
): string | null {
  const id = (citation as { passage_id?: unknown } | null | undefined)?.passage_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
