import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  beginThreadRequest,
  cancelThreadRequest,
  createThreadRequestGate,
  isCurrentThreadRequest,
  type ThreadRequestGate,
} from '../apps/web/lib/thread-request.js';

/**
 * Reader thread-open staleness regression (frontend-only).
 *
 * Thread-detail fetches can resolve out of order: opening thread A then B may
 * let A's later response overwrite B, and a response that lands after the
 * panel closes may reopen it. `openThread` now takes a monotonic token from a
 * request gate before it touches context state or awaits, and only the current
 * token may write thread state, panel mode, error text, or scroll.
 *
 * Like reader-stream-cancel.test.ts, this repo has no DOM harness, so coverage
 * is (a) pure unit tests of the gate plus a local harness that mirrors
 * openThread's begin -> await -> guarded-apply sequence, and (b) source-contract
 * tests in the established readFileSync idiom. These verify the request-gate
 * behaviour and its integration points in ReaderClient.tsx; they do not render
 * a React interaction.
 */

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');

/** Slice a top-level function body: from marker to the next marker. */
function bodyBetween(s: string, startMarker: string, endMarker: string): string {
  const start = s.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = s.indexOf(endMarker, start);
  return s.slice(start, end === -1 ? undefined : end);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Applied {
  threadId: string | null;
  detail: string | null;
  error: string | null;
}

function emptyState(): Applied {
  return { threadId: null, detail: null, error: null };
}

/**
 * Mirrors openThread: claim the gate synchronously at call time, await the
 * detail request, then apply only while the token is still current. Both the
 * success and failure branches are guarded, matching the component.
 */
function startOpen(
  gate: ThreadRequestGate,
  threadId: string,
  request: Promise<string>,
  state: Applied,
): Promise<void> {
  const token = beginThreadRequest(gate);
  return request.then(
    (detail) => {
      if (!isCurrentThreadRequest(gate, token)) return;
      state.threadId = threadId;
      state.detail = detail;
      state.error = null;
    },
    (error: unknown) => {
      if (!isCurrentThreadRequest(gate, token)) return;
      state.error = error instanceof Error ? error.message : String(error);
    },
  );
}

describe('thread request gate (unit)', () => {
  it('a fresh gate owns no request and tokens are monotonic', () => {
    const gate = createThreadRequestGate();
    expect(isCurrentThreadRequest(gate, 0)).toBe(false);
    const first = beginThreadRequest(gate);
    const second = beginThreadRequest(gate);
    expect(second).toBeGreaterThan(first);
    expect(isCurrentThreadRequest(gate, first)).toBe(false);
    expect(isCurrentThreadRequest(gate, second)).toBe(true);
  });

  it('open A, then B: B finishes first and A finishing last stays stale', async () => {
    const gate = createThreadRequestGate();
    const state = emptyState();
    const a = deferred<string>();
    const b = deferred<string>();

    const aDone = startOpen(gate, 'A', a.promise, state);
    const bDone = startOpen(gate, 'B', b.promise, state);

    // B answers first and becomes the open thread.
    b.resolve('B-detail');
    await bDone;
    expect(state.threadId).toBe('B');
    expect(state.detail).toBe('B-detail');

    // A answers last: it must apply nothing.
    a.resolve('A-detail');
    await aDone;
    expect(state.threadId).toBe('B');
    expect(state.detail).toBe('B-detail');
    expect(state.error).toBeNull();
  });

  it('close before completion: a late response never reopens the thread', async () => {
    const gate = createThreadRequestGate();
    const state = emptyState();
    const a = deferred<string>();

    const aDone = startOpen(gate, 'A', a.promise, state);
    // closeThread -> clearThreadState invalidates pending thread opens.
    cancelThreadRequest(gate);

    a.resolve('A-detail');
    await aDone;
    expect(state).toEqual({ threadId: null, detail: null, error: null });
  });

  it('a stale failure never replaces the current thread or its error state', async () => {
    const gate = createThreadRequestGate();
    const state = emptyState();
    const a = deferred<string>();
    const b = deferred<string>();

    const aDone = startOpen(gate, 'A', a.promise, state);
    const bDone = startOpen(gate, 'B', b.promise, state);

    b.resolve('B-detail');
    await bDone;

    a.reject(new Error('A failed'));
    await aDone;
    expect(state.threadId).toBe('B');
    expect(state.detail).toBe('B-detail');
    expect(state.error).toBeNull();
  });

  it('a current failure still surfaces (normal error path preserved)', async () => {
    const gate = createThreadRequestGate();
    const state = emptyState();
    const a = deferred<string>();

    const aDone = startOpen(gate, 'A', a.promise, state);
    a.reject(new Error('could not reopen thread'));
    await aDone;
    expect(state.threadId).toBeNull();
    expect(state.error).toBe('could not reopen thread');
  });

  it('normal open works, and the same thread id reopens after cancellation', async () => {
    const gate = createThreadRequestGate();
    const state = emptyState();

    const first = deferred<string>();
    const firstDone = startOpen(gate, 'A', first.promise, state);
    first.resolve('first-detail');
    await firstDone;
    expect(state).toMatchObject({ threadId: 'A', detail: 'first-detail', error: null });

    // Close, then reopen the SAME id: a new token, not an id comparison.
    cancelThreadRequest(gate);
    state.threadId = null;
    state.detail = null;

    const second = deferred<string>();
    const secondDone = startOpen(gate, 'A', second.promise, state);
    second.resolve('second-detail');
    await secondDone;
    expect(state).toMatchObject({ threadId: 'A', detail: 'second-detail', error: null });
  });
});

describe('ReaderClient thread-open staleness (source contract)', () => {
  it('owns a request gate in a ref', () => {
    const s = src();
    expect(s).toMatch(/const threadRequests = useRef\(createThreadRequestGate\(\)\)/);
    expect(s).toMatch(
      /import \{[\s\S]*?beginThreadRequest,[\s\S]*?cancelThreadRequest,[\s\S]*?createThreadRequestGate,[\s\S]*?isCurrentThreadRequest,[\s\S]*?\} from '@\/lib\/thread-request';/,
    );
  });

  it('claims the token synchronously, before context state and the await', () => {
    const s = src();
    const body = bodyBetween(s, 'async function openThread', 'async function explain()');
    const tokenIdx = body.indexOf('const requestToken = beginThreadRequest(threadRequests.current)');
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    // Before mutating context state...
    expect(tokenIdx).toBeLessThan(body.indexOf("setError('')"));
    expect(tokenIdx).toBeLessThan(body.indexOf('setActivePassageId(contextPassageId)'));
    // ...and before awaiting the thread detail.
    expect(tokenIdx).toBeLessThan(body.indexOf('await browserReq(`/api/threads/${threadId}`)'));
  });

  it('checks currency after the fetch, before any thread UI state changes', () => {
    const s = src();
    const body = bodyBetween(s, 'async function openThread', 'async function explain()');
    const awaitIdx = body.indexOf('await browserReq(`/api/threads/${threadId}`)');
    const guardIdx = body.indexOf(
      'if (!isCurrentThreadRequest(threadRequests.current, requestToken)) return;',
    );
    expect(awaitIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(awaitIdx);
    // Stale responses cannot set the thread, its detail, the panel mode, or scroll.
    expect(guardIdx).toBeLessThan(body.indexOf('setOpenThreadId(threadId)'));
    expect(guardIdx).toBeLessThan(body.indexOf('applyThreadDetail(r)'));
    expect(guardIdx).toBeLessThan(body.indexOf("setPanelMode('expanded')"));
    expect(guardIdx).toBeLessThan(body.indexOf('revealThreadPanel()'));
    expect(guardIdx).toBeLessThan(body.indexOf('scrollToPassage(contextPassageId)'));
  });

  it('ignores failures from superseded requests', () => {
    const s = src();
    const body = bodyBetween(s, 'async function openThread', 'async function explain()');
    const catchIdx = body.indexOf('} catch (e) {');
    expect(catchIdx).toBeGreaterThanOrEqual(0);
    const catchBody = body.slice(catchIdx);
    const guardIdx = catchBody.indexOf(
      'if (!isCurrentThreadRequest(threadRequests.current, requestToken)) return;',
    );
    const errorIdx = catchBody.indexOf(
      "setError(requestErrorMessage(e, 'could not reopen thread'))",
    );
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThan(guardIdx);
  });

  it('thread close invalidates pending thread opens', () => {
    const s = src();
    const clearBody = bodyBetween(s, 'function clearThreadState()', 'function closeThread');
    expect(clearBody).toMatch(/cancelThreadRequest\(threadRequests\.current\)/);
    // Existing stream-lane cancellation is preserved and still adjacent.
    expect(clearBody).toMatch(/laneCancel\(explainLane\.current\)/);
    expect(clearBody).toMatch(/laneCancel\(followupLane\.current\)/);
  });

  it('unmount invalidates pending thread opens as well as both stream lanes', () => {
    const s = src();
    expect(s).toMatch(
      /useEffect\(\(\) => \(\) => \{\s*laneCancel\(explainLane\.current\);\s*laneCancel\(followupLane\.current\);[\s\S]*?cancelThreadRequest\(threadRequests\.current\);[\s\S]*?\}, \[\]\);/,
    );
  });

  it('the two laneCancel calls stay adjacent for existing contracts', () => {
    const s = src();
    expect(s).toMatch(
      /laneCancel\(explainLane\.current\);\s*\n\s*laneCancel\(followupLane\.current\);/,
    );
  });

  it('normal thread-opening behaviour is preserved', () => {
    const s = src();
    const body = bodyBetween(s, 'async function openThread', 'async function explain()');
    // Context still resolves from the persisted highlight before fetching.
    expect(body).toMatch(/highlights\.find\(\(h\) => h\.thread_id === threadId\)/);
    expect(body).toMatch(/if \(contextPassageId\) setActivePassageId\(contextPassageId\)/);
    expect(body).toMatch(/if \(contextAnchorId\) setActiveAnchorId\(contextAnchorId\)/);
    // The authoritative detail still opens and expands the exact thread.
    expect(body).toMatch(/setOpenThreadId\(threadId\)/);
    expect(body).toMatch(/applyThreadDetail\(r\)/);
    expect(body).toMatch(/setPanelMode\('expanded'\)/);
    // Navigation branches are unchanged: narrow reveals the panel, desktop
    // returns to the passage.
    expect(body).toMatch(/if \(isNarrowReader\(window\.innerWidth\)\) revealThreadPanel\(\);/);
    expect(body).toMatch(/else if \(contextPassageId\) scrollToPassage\(contextPassageId\)/);
    // The reopen error path still exists.
    expect(body).toMatch(/could not reopen thread/);
  });

  it('Explain is untouched by this scope decision', () => {
    const s = src();
    const body = bodyBetween(s, 'async function explain()', 'async function clickCitation');
    expect(body).not.toMatch(/threadRequests/);
    expect(body).not.toMatch(/beginThreadRequest/);
    expect(body).not.toMatch(/cancelThreadRequest/);
  });
});
