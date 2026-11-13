/**
 * Monotonic ownership token for thread-detail requests (`openThread`).
 *
 * Thread panels are keyed by a single active thread, but thread-detail fetches
 * can resolve out of order: opening A then B may let A's later response
 * overwrite B, and a response that resolves after the panel closes may reopen
 * it. Every request therefore takes a token from the gate; only the newest
 * token may write thread state. Cancellation (thread close, unmount) bumps the
 * gate too, so closing is authoritative.
 *
 * The gate is a plain mutable counter (used through a React ref): updates are
 * synchronous and re-render free, and a monotonic token also invalidates an
 * older request for the SAME thread id (close then reopen), which an
 * id-comparison guard could not distinguish.
 */
export interface ThreadRequestGate {
  current: number;
}

export function createThreadRequestGate(): ThreadRequestGate {
  return { current: 0 };
}

/** Claim ownership for a new request: every earlier token becomes stale. */
export function beginThreadRequest(gate: ThreadRequestGate): number {
  gate.current += 1;
  return gate.current;
}

/** Invalidate the in-flight request without starting a new one (close/unmount). */
export function cancelThreadRequest(gate: ThreadRequestGate): void {
  gate.current += 1;
}

/** True while the given token still owns the gate. Token 0 is never issued. */
export function isCurrentThreadRequest(gate: ThreadRequestGate, token: number): boolean {
  return token > 0 && gate.current === token;
}
