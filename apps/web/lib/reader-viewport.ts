/**
 * Reader layout breakpoint, mirrored from apps/web/app/globals.css
 * (`@media (max-width: 900px)`).
 *
 * At or below this width the reader is one column: the passage thread panel
 * is stacked after the entire document instead of sitting beside it. Anything
 * that opens a thread on a narrow viewport must therefore reveal the panel
 * itself; scrolling to the passage would leave the answer off-screen.
 *
 * Pure so it can be unit-tested without a DOM.
 */
export const NARROW_READER_MAX_WIDTH = 900;

/** True when the reader stacks (panel below the document). */
export function isNarrowReader(width: number): boolean {
  return width <= NARROW_READER_MAX_WIDTH;
}
