/**
 * Serialized, coalescing reader-progress saves.
 *
 * Scroll sampling can produce far more positions than the API should see, and
 * requests can overlap. This queue keeps at most one normal PUT in flight:
 * positions that arrive while it is running collapse into the newest one, so
 * the last position the reader actually reached is what gets written.
 *
 * Ordering guarantee. Dispatching is NOT fully serialized: pagehide and
 * visibility-hidden must send the newest position immediately, even while a
 * normal request is still in flight, otherwise the browser can unload before
 * the queue drains. Those two requests can finish in either order, so every
 * dispatch carries this reader instance's opaque id and a strictly increasing
 * sequence. The API applies a write only when it comes from another instance
 * (multi-tab last-write-wins by arrival, as agreed) or when its sequence is
 * newer than the stored one. An older request from this instance can therefore
 * never overwrite a newer position, whichever response lands first.
 *
 * Failure handling. A failed send is retried on a timer with capped
 * exponential backoff, so a transient outage does not require the reader to
 * scroll past the sampling threshold again and a persistent failure does not
 * hammer the API. Only a failure that is still the newest dispatch, with no
 * newer queued position, is retried: replaying an older payload after a newer
 * request succeeded would ask the server to accept an old position under a new
 * sequence and regress the stored position. `dispose()` stops timers and future work;
 * already-dispatched requests are not cancelled.
 */

export interface ProgressPayload {
  passageId: string;
  offsetRatio: number;
}

export interface ProgressTransportOptions {
  keepalive: boolean;
  /** Opaque per-reader-instance id shared by every dispatch from this saver. */
  instanceId: string;
  /** Strictly increasing per-instance dispatch counter. */
  sequence: number;
}

export type ProgressTransport = (
  payload: ProgressPayload,
  options: ProgressTransportOptions,
) => Promise<unknown>;

export interface ProgressSaver {
  /** Queue the latest position. Resolves true when it was delivered or superseded. */
  save(payload: ProgressPayload, options?: { keepalive?: boolean }): Promise<boolean>;
  /** Dispatch the pending position now (no-op when nothing is pending). */
  flush(options?: { keepalive?: boolean }): void;
  /** Stop accepting work and cancel retries. Dispatched requests are not cancelled. */
  dispose(): void;
  pending(): ProgressPayload | null;
  /** Resolves when every dispatched request has settled (tests/unmount helper). */
  idle(): Promise<void>;
}

export interface ProgressSaverDeps {
  /** Required: the ordering guard is meaningless without a per-instance id. */
  instanceId: string;
  equals?: (a: ProgressPayload, b: ProgressPayload) => boolean;
  /** Retry delay after a failed send. 0 disables automatic retries. */
  retryDelayMs?: number;
}

export const DEFAULT_PROGRESS_RETRY_DELAY_MS = 3000;

function sameProgress(a: ProgressPayload, b: ProgressPayload): boolean {
  return a.passageId === b.passageId && a.offsetRatio === b.offsetRatio;
}

function normalize(payload: ProgressPayload): ProgressPayload {
  return { passageId: payload.passageId, offsetRatio: payload.offsetRatio };
}

/**
 * UUID-shaped opaque id for one mounted reader instance. `crypto.randomUUID`
 * covers modern browsers and Node; the fallback keeps the value valid for the
 * strict API schema on older runtimes.
 */
export function createProgressInstanceId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createProgressSaver(
  transport: ProgressTransport,
  deps: ProgressSaverDeps,
): ProgressSaver {
  const equals = deps.equals ?? sameProgress;
  const instanceId = deps.instanceId;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_PROGRESS_RETRY_DELAY_MS;
  let pending: ProgressPayload | null = null;
  let lastSent: ProgressPayload | null = null;
  let lastSentSequence = 0;
  let latestDispatchedSequence = 0;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let nextSequence = 1;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const maxRetryDelay = Math.max(retryDelayMs, 30_000);
  let nextRetryDelay = retryDelayMs;
  const dispatched: Array<Promise<void>> = [];

  function track(work: Promise<void>): void {
    dispatched.push(work);
    // Bounded: keepalive/unmount sends are rare, but never grow unbounded.
    if (dispatched.length > 32) dispatched.splice(0, dispatched.length - 32);
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(): void {
    if (disposed || retryDelayMs <= 0 || retryTimer !== null || !pending) return;
    const delay = nextRetryDelay;
    // Back off on repeated failures so an offline reader (or an expired
    // session) does not hammer the API on a fixed interval. A successful send
    // restores the base delay.
    nextRetryDelay = Math.min(maxRetryDelay, Math.max(retryDelayMs, nextRetryDelay * 2));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed || !pending) return;
      void startDrain();
    }, delay);
  }

  async function send(
    payload: ProgressPayload,
    keepalive: boolean,
  ): Promise<{ ok: boolean; sequence: number }> {
    const sequence = nextSequence;
    nextSequence += 1;
    // Recorded at dispatch, not on response: a request that is still in flight
    // is already newer than anything dispatched before it.
    latestDispatchedSequence = sequence;
    try {
      await transport(payload, { keepalive, instanceId, sequence });
    } catch {
      return { ok: false, sequence };
    }
    nextRetryDelay = retryDelayMs;
    // Responses may land out of order. Only a newer acknowledgement may move
    // the dedupe marker forward, otherwise a late older response would make
    // the queue re-send an obsolete position.
    if (sequence > lastSentSequence) {
      lastSentSequence = sequence;
      lastSent = payload;
    }
    return { ok: true, sequence };
  }

  /**
   * A failed dispatch may only be replayed when nothing newer exists: no
   * newer position is queued, and no newer request (in flight or settled) has
   * been dispatched. Replaying an older payload after a newer request already
   * succeeded would send a NEW sequence for an OLD position, which the server
   * correctly accepts and which would regress the stored position.
   */
  function requeueAfterFailure(payload: ProgressPayload, sequence: number): void {
    if (disposed) return;
    if (pending) return;
    if (sequence < latestDispatchedSequence) return;
    pending = payload;
  }

  async function drain(): Promise<void> {
    while (!disposed && pending) {
      const next = pending;
      pending = null;
      const result = await send(next, false);
      if (!result.ok) {
        // A newer position queued while this request was in flight is the one
        // that matters: send it now rather than waiting for the retry timer.
        if (pending) continue;
        requeueAfterFailure(next, result.sequence);
        scheduleRetry();
        return;
      }
    }
  }

  function startDrain(): Promise<void> {
    clearRetry();
    if (!inFlight) {
      let run: Promise<void>;
      run = drain().finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
    }
    return inFlight;
  }

  return {
    async save(payload, options = {}) {
      if (disposed) return false;
      const next = normalize(payload);

      // An identical position that is already acknowledged has nothing left to
      // send. This keeps repeated pagehide/visibility events from re-PUTting
      // the same point. A queued or in-flight position is deliberately NOT
      // skipped: that is exactly when the keepalive copy is needed, because
      // the normal request may never complete.
      if (!pending && !inFlight && lastSent && equals(lastSent, next)) return true;

      if (options.keepalive === true) {
        // Newest wins even while a normal request is in flight: the page may
        // be unloading and that older request may never complete. The newer
        // sequence makes the server ignore the older write if it lands last.
        pending = null;
        const current = next;
        const work = send(current, true).then((result) => {
          if (result.ok) return;
          requeueAfterFailure(current, result.sequence);
          scheduleRetry();
        });
        track(work);
        await work;
        return lastSent !== null && equals(lastSent, current);
      }

      pending = next;
      await startDrain();
      return !disposed && pending === null;
    },

    flush(options = {}) {
      if (disposed || !pending) return;
      const next = pending;
      pending = null;
      const work = send(next, options.keepalive === true).then((result) => {
        if (result.ok) return;
        requeueAfterFailure(next, result.sequence);
        scheduleRetry();
      });
      track(work);
    },

    dispose() {
      disposed = true;
      pending = null;
      clearRetry();
    },

    pending() {
      return pending;
    },

    async idle() {
      await Promise.all([...(inFlight ? [inFlight] : []), ...dispatched]);
    },
  };
}
