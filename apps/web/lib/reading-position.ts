/**
 * Reader progress geometry (pure, DOM-free).
 *
 * A "reading line" is a fixed fraction of the viewport height. Sampling maps
 * that line onto the passage it crosses and records how far through that
 * passage the line sits (0..1). Restoring applies the inverse: place the
 * passage so the same relative point returns to the reading line.
 *
 * Passage ids are the stable anchors; the ratio is relative to the passage's
 * own height, so it survives font-size, viewport, and layout changes. Raw
 * screen coordinates are never persisted.
 */

/** Reading line position as a fraction of viewport height. */
export const READING_LINE_RATIO = 0.4;

/** Ratio movement below this is not worth a network round trip. */
export const PROGRESS_SAVE_EPSILON = 0.01;

/** Positions this close to the first passage's start count as "beginning". */
export const BEGINNING_RATIO_EPSILON = 0.01;

export interface PassageBand {
  id: string;
  top: number;
  bottom: number;
}

export interface DocBand {
  top: number;
  bottom: number;
}

export interface ProgressSample {
  passageId: string;
  offsetRatio: number;
}

export interface ResumeGeometry {
  scrollY: number;
  passageTop: number;
  passageHeight: number;
  lineY: number;
  maxScrollTop: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The reading line only samples while it crosses the document surface. */
export function isReadingLineInsideDoc(doc: DocBand, lineY: number): boolean {
  return Number.isFinite(lineY) && lineY >= doc.top && lineY <= doc.bottom;
}

/**
 * Passage under the reading line, in document order.
 *
 * - Line above the first passage → first passage, ratio 0.
 * - Line inside a passage → that passage, ratio = distance / height.
 * - Line in the gap between two passages → the next passage, ratio 0, so
 *   resuming continues at the next readable unit instead of the tail of the
 *   previous one.
 * - Line past the last passage → last passage, ratio 1.
 *
 * `bands` must be ordered top-to-bottom. A two-band window around the line is
 * enough for the DOM sampler; the full list is supported too.
 */
export function passageAtLine(bands: PassageBand[], lineY: number): ProgressSample | null {
  if (bands.length === 0) return null;

  let current = -1;
  for (let i = 0; i < bands.length; i += 1) {
    if (bands[i].top <= lineY) current = i;
    else break;
  }
  if (current < 0) return { passageId: bands[0].id, offsetRatio: 0 };

  const band = bands[current];
  const height = band.bottom - band.top;
  if (height > 0 && lineY <= band.bottom) {
    return {
      passageId: band.id,
      offsetRatio: clamp01((lineY - band.top) / height),
    };
  }

  const next = bands[current + 1];
  if (next) return { passageId: next.id, offsetRatio: 0 };
  return { passageId: band.id, offsetRatio: 1 };
}

/** Absolute scroll offset that puts a saved sample back on the reading line. */
export function resumeScrollTop(sample: ProgressSample, geometry: ResumeGeometry): number {
  const raw =
    geometry.scrollY +
    geometry.passageTop +
    clamp01(sample.offsetRatio) * geometry.passageHeight -
    geometry.lineY;
  if (!Number.isFinite(raw)) return 0;
  const max = Number.isFinite(geometry.maxScrollTop) ? Math.max(0, geometry.maxScrollTop) : 0;
  return Math.min(Math.max(0, raw), max);
}

/** True when the new sample differs enough from the last queued one. */
export function shouldQueueProgress(
  previous: ProgressSample | null,
  next: ProgressSample,
): boolean {
  if (!previous) return true;
  if (previous.passageId !== next.passageId) return true;
  return Math.abs(previous.offsetRatio - next.offsetRatio) >= PROGRESS_SAVE_EPSILON;
}

/**
 * A saved point that would land the reader at the very start of the document
 * carries no useful information: the resume prompt is suppressed for it.
 */
export function progressIsAtBeginning(
  progress: { passageId: string; offsetRatio: number } | null | undefined,
  firstPassageId: string | undefined,
): boolean {
  if (!progress || !firstPassageId) return false;
  return progress.passageId === firstPassageId
    && clamp01(progress.offsetRatio) <= BEGINNING_RATIO_EPSILON;
}
