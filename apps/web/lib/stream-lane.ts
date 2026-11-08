/**
 * Per-flow cancellation lanes for thread SSE streams (Reader Explain vs
 * follow-up). Each lane owns an independent AbortController so concurrent
 * flows can never cancel or invalidate each other; `cancelled` is set ONLY
 * at intentional sites (component unmount, thread close), letting callers
 * tell intentional cancellation (stay silent) apart from transport failures
 * (error/fallback path) and superseded completions (ignore, never fabricate).
 */
export interface StreamLane {
  ctrl: AbortController | null;
  cancelled: boolean;
}

export function createStreamLane(): StreamLane {
  return { ctrl: null, cancelled: false };
}

/** Start a new request on this lane: fresh controller, clears prior state. */
export function laneBegin(lane: StreamLane): AbortController {
  const ctrl = new AbortController();
  lane.ctrl = ctrl;
  lane.cancelled = false;
  return ctrl;
}

/** True while the given controller still owns this lane and is not aborted. */
export function laneIsCurrent(lane: StreamLane, ctrl: AbortController | null): boolean {
  return ctrl !== null && lane.ctrl === ctrl && !ctrl.signal.aborted;
}

/** Intentional cancellation (unmount/close): abort, release, remember it. */
export function laneCancel(lane: StreamLane): void {
  lane.cancelled = true;
  try {
    lane.ctrl?.abort();
  } catch {
    /* already settled */
  }
  lane.ctrl = null;
}

/** Successful completion: release the lane only if still owned by ctrl. */
export function laneSettle(lane: StreamLane, ctrl: AbortController | null): void {
  if (ctrl !== null && lane.ctrl === ctrl) lane.ctrl = null;
}
