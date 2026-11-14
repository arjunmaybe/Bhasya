import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEGINNING_RATIO_EPSILON,
  PROGRESS_SAVE_EPSILON,
  READING_LINE_RATIO,
  isReadingLineInsideDoc,
  passageAtLine,
  progressIsAtBeginning,
  resumeScrollTop,
  shouldQueueProgress,
  type PassageBand,
} from '../apps/web/lib/reading-position.js';
import {
  createProgressInstanceId,
  createProgressSaver,
  type ProgressPayload,
  type ProgressTransportOptions,
} from '../apps/web/lib/progress-save.js';

const INSTANCE = '11111111-1111-4111-8111-111111111111';

const readerSource = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const pageSource = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/read/[versionId]/page.tsx'), 'utf8');
const apiSource = () =>
  readFileSync(join(process.cwd(), 'apps/web/lib/api.ts'), 'utf8');
const cssSource = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

function bodyBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return source.slice(start, end);
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RecordedCall {
  payload: ProgressPayload;
  options: ProgressTransportOptions;
}

/** Transport that records dispatches and holds each one until released. */
function gatedTransport() {
  const calls: RecordedCall[] = [];
  const gates: Deferred[] = [];
  const transport = async (payload: ProgressPayload, options: ProgressTransportOptions) => {
    calls.push({ payload, options });
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
  };
  return { calls, gates, transport };
}

// Passages with a real gap (100→160) and a trailing gap after the last one.
const BANDS: PassageBand[] = [
  { id: 'a', top: 0, bottom: 100 },
  { id: 'b', top: 160, bottom: 260 },
  { id: 'c', top: 300, bottom: 400 },
];

describe('reading position: passage-relative sampling', () => {
  it('uses a fixed reading line and no raw screen coordinates', () => {
    expect(READING_LINE_RATIO).toBeGreaterThan(0);
    expect(READING_LINE_RATIO).toBeLessThan(1);
    expect(PROGRESS_SAVE_EPSILON).toBeGreaterThan(0);
    expect(BEGINNING_RATIO_EPSILON).toBeGreaterThanOrEqual(0);
  });

  it('resolves the passage under the line and its relative offset', () => {
    expect(passageAtLine(BANDS, -20)).toEqual({ passageId: 'a', offsetRatio: 0 });
    expect(passageAtLine(BANDS, 0)).toEqual({ passageId: 'a', offsetRatio: 0 });
    expect(passageAtLine(BANDS, 50)).toEqual({ passageId: 'a', offsetRatio: 0.5 });
    expect(passageAtLine(BANDS, 100)).toEqual({ passageId: 'a', offsetRatio: 1 });
    expect(passageAtLine(BANDS, 200)).toEqual({ passageId: 'b', offsetRatio: 0.4 });
  });

  it('treats a gap between passages as the start of the next passage', () => {
    expect(passageAtLine(BANDS, 101)).toEqual({ passageId: 'b', offsetRatio: 0 });
    expect(passageAtLine(BANDS, 159)).toEqual({ passageId: 'b', offsetRatio: 0 });
    expect(passageAtLine(BANDS, 270)).toEqual({ passageId: 'c', offsetRatio: 0 });
  });

  it('clamps before the first and after the last passage', () => {
    expect(passageAtLine(BANDS, 400)).toEqual({ passageId: 'c', offsetRatio: 1 });
    expect(passageAtLine(BANDS, 5000)).toEqual({ passageId: 'c', offsetRatio: 1 });
    expect(passageAtLine([], 50)).toBeNull();
  });

  it('only samples while the reading line crosses the document surface', () => {
    expect(isReadingLineInsideDoc({ top: 0, bottom: 900 }, 360)).toBe(true);
    expect(isReadingLineInsideDoc({ top: 120, bottom: 900 }, 60)).toBe(false);
    expect(isReadingLineInsideDoc({ top: 0, bottom: 400 }, 480)).toBe(false);
    expect(isReadingLineInsideDoc({ top: 0, bottom: 400 }, Number.NaN)).toBe(false);
  });
});

describe('reading position: restore geometry', () => {
  it('returns the saved point to the reading line', () => {
    // Passage started 200px above the viewport; line half-way through it.
    const top = resumeScrollTop({ passageId: 'a', offsetRatio: 0.5 }, {
      scrollY: 1000,
      passageTop: -200,
      passageHeight: 100,
      lineY: 400,
      maxScrollTop: 5000,
    });
    expect(top).toBe(450);
  });

  it('clamps to the top and to the maximum scroll offset', () => {
    expect(resumeScrollTop({ passageId: 'a', offsetRatio: 0 }, {
      scrollY: 0,
      passageTop: 10,
      passageHeight: 100,
      lineY: 800,
      maxScrollTop: 5000,
    })).toBe(0);

    expect(resumeScrollTop({ passageId: 'a', offsetRatio: 1 }, {
      scrollY: 900,
      passageTop: 500,
      passageHeight: 400,
      lineY: 100,
      maxScrollTop: 1200,
    })).toBe(1200);
  });

  it('is the inverse of sampling for the same layout', () => {
    const lineY = 400;
    const scrollY = 1200;
    // Passage top in document coordinates: 1500 → viewport top = 300.
    const passageTop = 1500 - scrollY;
    const sample = passageAtLine(
      [{ id: 'a', top: passageTop, bottom: passageTop + 200 }],
      lineY,
    );
    expect(sample).toEqual({ passageId: 'a', offsetRatio: 0.5 });
    const restored = resumeScrollTop(sample!, {
      scrollY,
      passageTop,
      passageHeight: 200,
      lineY,
      maxScrollTop: 10_000,
    });
    expect(restored).toBe(1500 + 100 - lineY);
  });
});

describe('reading position: queueing policy', () => {
  it('queues new passages and meaningful ratio movement only', () => {
    expect(shouldQueueProgress(null, { passageId: 'a', offsetRatio: 0.1 })).toBe(true);
    expect(shouldQueueProgress(
      { passageId: 'a', offsetRatio: 0.1 },
      { passageId: 'b', offsetRatio: 0.1 },
    )).toBe(true);
    expect(shouldQueueProgress(
      { passageId: 'a', offsetRatio: 0.1 },
      { passageId: 'a', offsetRatio: 0.1 + PROGRESS_SAVE_EPSILON / 2 },
    )).toBe(false);
    expect(shouldQueueProgress(
      { passageId: 'a', offsetRatio: 0.1 },
      { passageId: 'a', offsetRatio: 0.1 + PROGRESS_SAVE_EPSILON * 2 },
    )).toBe(true);
  });

  it('suppresses the prompt only for a saved point at the document start', () => {
    expect(progressIsAtBeginning({ passageId: 'first', offsetRatio: 0 }, 'first')).toBe(true);
    expect(progressIsAtBeginning({ passageId: 'first', offsetRatio: BEGINNING_RATIO_EPSILON }, 'first')).toBe(true);
    expect(progressIsAtBeginning({ passageId: 'first', offsetRatio: 0.05 }, 'first')).toBe(false);
    expect(progressIsAtBeginning({ passageId: 'second', offsetRatio: 0 }, 'first')).toBe(false);
    expect(progressIsAtBeginning(null, 'first')).toBe(false);
    expect(progressIsAtBeginning({ passageId: 'first', offsetRatio: 0 }, undefined)).toBe(false);
  });
});

describe('progress save queue', () => {
  it('serializes normal sends and collapses positions to the newest', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });

    const first = saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    expect(calls.map((c) => c.payload.offsetRatio)).toEqual([0.1]);

    const second = saver.save({ passageId: 'a', offsetRatio: 0.2 });
    const third = saver.save({ passageId: 'a', offsetRatio: 0.3 });
    expect(calls.length).toBe(1);

    gates[0].resolve();
    await settleMicrotasks();
    expect(calls.map((c) => c.payload.offsetRatio)).toEqual([0.1, 0.3]);

    gates[1].resolve();
    await Promise.all([first, second, third]);
    expect(calls.map((c) => c.payload.offsetRatio)).toEqual([0.1, 0.3]);
  });

  it('numbers every dispatch from one reader instance with a strictly increasing sequence', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    void saver.save({ passageId: 'a', offsetRatio: 0.4 }, { keepalive: true });
    await settleMicrotasks();
    void saver.save({ passageId: 'b', offsetRatio: 0.2 });
    await settleMicrotasks();
    saver.flush({ keepalive: true });
    await settleMicrotasks();

    expect(calls.map((c) => c.options.sequence)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.options.instanceId)).toEqual([INSTANCE, INSTANCE, INSTANCE]);
    expect(calls.map((c) => c.options.keepalive)).toEqual([false, true, true]);

    gates[0].resolve();
    gates[1].resolve();
    gates[2].resolve();
    await saver.idle();
  });

  // Regression: a normal request begins, a newer keepalive request is
  // dispatched, responses complete in reverse order. The stored position must
  // be the newer one — enforced by the server-side per-instance sequence
  // guard, and the client must not let the late response resurrect the stale
  // position as the next thing it sends.
  it('keeps the newer position when responses complete in reverse order', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });

    const first = saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    expect(calls.length).toBe(1);
    expect(calls[0].options.sequence).toBe(1);

    // The page hides while the normal request is still in flight.
    void saver.save({ passageId: 'c', offsetRatio: 0.9 }, { keepalive: true });
    await settleMicrotasks();
    expect(calls.length).toBe(2);
    expect(calls[1].options.keepalive).toBe(true);
    expect(calls[1].options.sequence).toBeGreaterThan(calls[0].options.sequence);

    // Newer response lands first, older one last.
    gates[1].resolve();
    await settleMicrotasks();
    gates[0].resolve();
    await first;

    // The tracked acknowledgement must stay on the newer write: an identical
    // position is deduped instead of being dispatched after the late response.
    expect(await saver.save({ passageId: 'c', offsetRatio: 0.9 })).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('flushes the pending position during an in-flight request with a newer sequence', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    void saver.save({ passageId: 'b', offsetRatio: 0.2 });
    expect(saver.pending()?.passageId).toBe('b');

    saver.flush({ keepalive: true });
    await settleMicrotasks();
    expect(calls.length).toBe(2);
    expect(calls[1].payload).toEqual({ passageId: 'b', offsetRatio: 0.2 });
    expect(calls[1].options).toEqual({ keepalive: true, instanceId: INSTANCE, sequence: 2 });
    expect(saver.pending()).toBeNull();

    // Reverse completion: the newer flush resolves before the older send.
    gates[1].resolve();
    await settleMicrotasks();
    gates[0].resolve();
    await saver.idle();
  });

  it('flushes the newest pending position during unmount without cancelling it', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    void saver.save({ passageId: 'b', offsetRatio: 0.8 });

    // Reader unmount sequence: queue, flush with keepalive, then dispose.
    saver.flush({ keepalive: true });
    saver.dispose();

    expect(calls.length).toBe(2);
    expect(calls[1].payload.passageId).toBe('b');
    expect(calls[1].options.keepalive).toBe(true);
    expect(calls[1].options.sequence).toBeGreaterThan(calls[0].options.sequence);
    expect(saver.pending()).toBeNull();

    gates[0].resolve();
    gates[1].resolve();
    await saver.idle();
  });

  it('retries a transient failure without another save or scroll', async () => {
    const sent: number[] = [];
    const sequences: number[] = [];
    let attempts = 0;
    const saver = createProgressSaver(async (payload, options) => {
      sent.push(payload.offsetRatio);
      sequences.push(options.sequence);
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    }, { instanceId: INSTANCE, retryDelayMs: 5 });

    expect(await saver.save({ passageId: 'a', offsetRatio: 0.1 })).toBe(false);
    expect(saver.pending()?.offsetRatio).toBe(0.1);

    await waitUntil(() => sent.length === 2);
    expect(sent).toEqual([0.1, 0.1]);
    expect(sequences).toEqual([1, 2]);
    expect(saver.pending()).toBeNull();
    saver.dispose();
  });

  it('keeps the newest unsent position after a failure and retries on the next save', async () => {
    const sent: number[] = [];
    let attempts = 0;
    const saver = createProgressSaver(async (payload) => {
      sent.push(payload.offsetRatio);
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    }, { instanceId: INSTANCE, retryDelayMs: 0 });

    const failed = await saver.save({ passageId: 'a', offsetRatio: 0.1 });
    expect(failed).toBe(false);
    expect(saver.pending()?.offsetRatio).toBe(0.1);

    const retried = await saver.save({ passageId: 'a', offsetRatio: 0.25 });
    expect(retried).toBe(true);
    expect(sent).toEqual([0.1, 0.25]);
    expect(saver.pending()).toBeNull();
  });

  it('drops an older failure that lands after a newer keepalive succeeded', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE, retryDelayMs: 5 });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    void saver.save({ passageId: 'c', offsetRatio: 0.9 }, { keepalive: true });
    await settleMicrotasks();
    expect(calls.map((c) => c.options.sequence)).toEqual([1, 2]);

    // The newer keepalive succeeds first.
    gates[1].resolve();
    await settleMicrotasks();
    // The older normal request fails afterwards.
    gates[0].reject(new Error('offline'));
    await settleMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // It must not be re-queued and retried as a newer sequence.
    expect(saver.pending()).toBeNull();
    expect(calls.map((c) => c.options.sequence)).toEqual([1, 2]);
    saver.dispose();
  });

  it('drops an older failure while a newer request is still in flight', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE, retryDelayMs: 5 });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    void saver.save({ passageId: 'c', offsetRatio: 0.9 }, { keepalive: true });
    await settleMicrotasks();

    // The older request fails while the newer one has not settled yet.
    gates[0].reject(new Error('offline'));
    await settleMicrotasks();
    expect(saver.pending()).toBeNull();

    gates[1].resolve();
    await settleMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.map((c) => c.options.sequence)).toEqual([1, 2]);
    saver.dispose();
  });

  it('never replaces a newer pending position with an older failure', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE, retryDelayMs: 5 });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    // A newer position is queued while the older request is in flight.
    void saver.save({ passageId: 'c', offsetRatio: 0.7 });
    expect(saver.pending()?.passageId).toBe('c');

    gates[0].reject(new Error('offline'));
    await settleMicrotasks();

    // The queued newer position is sent next; the failed older payload is gone.
    expect(calls.map((c) => [c.payload.passageId, c.options.sequence]))
      .toEqual([['a', 1], ['c', 2]]);
    gates[1].resolve();
    await saver.idle();
    expect(saver.pending()).toBeNull();
    saver.dispose();
  });

  it('a Strict Mode replay receives a working saver instead of a disposed ref', async () => {
    // The old render-time ref pattern: one saver for the whole component
    // lifetime, so the simulated cleanup's dispose() poisons it forever.
    const poisoned = createProgressSaver(async () => {}, { instanceId: INSTANCE });
    poisoned.dispose();
    expect(await poisoned.save({ passageId: 'a', offsetRatio: 0.1 })).toBe(false);

    // The effect-scoped strategy disposes only its own setup; the replay's
    // fresh saver saves normally.
    const sent: number[] = [];
    const mount = () => createProgressSaver(async (payload) => {
      sent.push(payload.offsetRatio);
    }, { instanceId: INSTANCE });
    const first = mount();
    first.dispose();
    const replay = mount();
    expect(await replay.save({ passageId: 'a', offsetRatio: 0.4 })).toBe(true);
    expect(sent).toEqual([0.4]);
    replay.dispose();
  });

  it('does not re-send an unchanged position', async () => {
    const sent: ProgressPayload[] = [];
    const saver = createProgressSaver(async (payload) => { sent.push(payload); }, {
      instanceId: INSTANCE,
    });
    await saver.save({ passageId: 'a', offsetRatio: 0.4 });
    await saver.save({ passageId: 'a', offsetRatio: 0.4 });
    expect(sent.length).toBe(1);
  });

  // Regression: the last queued position is already being sent, so the unload
  // sample looks unchanged. It must still leave with keepalive, because the
  // normal request can be dropped by the browser during unload.
  it('dispatches an identical keepalive position while the normal request is in flight', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });
    const position = { passageId: 'a', offsetRatio: 0.4 };

    void saver.save(position);
    await settleMicrotasks();
    void saver.save(position, { keepalive: true });
    await settleMicrotasks();

    expect(calls.length).toBe(2);
    expect(calls[1].payload).toEqual(calls[0].payload);
    expect(calls[1].options).toEqual({ keepalive: true, instanceId: INSTANCE, sequence: 2 });

    // Reverse completion: the newer keepalive lands first, the older duplicate
    // last. The tracked acknowledgement stays on the newer write.
    gates[1].resolve();
    await settleMicrotasks();
    gates[0].resolve();
    await saver.idle();
    expect(await saver.save(position, { keepalive: true })).toBe(true);
    expect(calls.length).toBe(2);
    saver.dispose();
  });

  it('does not re-send an acknowledged identical position on repeated unload events', async () => {
    const calls: RecordedCall[] = [];
    const saver = createProgressSaver(async (payload, options) => {
      calls.push({ payload, options });
    }, { instanceId: INSTANCE });
    const position = { passageId: 'a', offsetRatio: 0.4 };

    expect(await saver.save(position)).toBe(true);
    expect(await saver.save(position, { keepalive: true })).toBe(true);
    expect(await saver.save(position, { keepalive: true })).toBe(true);

    expect(calls.length).toBe(1);
    expect(calls[0].options.keepalive).toBe(false);
    saver.dispose();
  });

  it('still sends an identical keepalive while that position is queued', async () => {
    const { calls, gates, transport } = gatedTransport();
    const saver = createProgressSaver(transport, { instanceId: INSTANCE });
    const position = { passageId: 'a', offsetRatio: 0.4 };

    void saver.save(position);
    await settleMicrotasks();
    // Queue an identical normal position behind the in-flight request.
    void saver.save(position);
    expect(saver.pending()).toEqual(position);

    void saver.save(position, { keepalive: true });
    await settleMicrotasks();

    expect(calls.length).toBe(2);
    expect(calls[1].payload).toEqual(position);
    expect(calls[1].options.keepalive).toBe(true);
    expect(calls[1].options.sequence).toBe(2);
    expect(saver.pending()).toBeNull();

    gates[0].resolve();
    gates[1].resolve();
    await saver.idle();
    saver.dispose();
  });

  it('stops accepting work after dispose without cancelling dispatched sends', async () => {
    const sent: number[] = [];
    const gate = deferred();
    const saver = createProgressSaver(async (payload) => {
      sent.push(payload.offsetRatio);
      await gate.promise;
    }, { instanceId: INSTANCE, retryDelayMs: 0 });

    void saver.save({ passageId: 'a', offsetRatio: 0.1 });
    await settleMicrotasks();
    void saver.save({ passageId: 'b', offsetRatio: 0.2 });
    expect(saver.pending()?.passageId).toBe('b');

    saver.dispose();
    expect(saver.pending()).toBeNull();
    expect(await saver.save({ passageId: 'c', offsetRatio: 0.3 })).toBe(false);

    gate.resolve();
    await saver.idle();
    expect(sent).toEqual([0.1]);
  });

  it('creates an opaque UUID instance id for the ordering guard', () => {
    const id = createProgressInstanceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createProgressInstanceId()).not.toBe(id);
  });
});

describe('reader resume: source contracts', () => {
  it('loads progress server-side without breaking the document', () => {
    const page = pageSource();
    expect(page).toMatch(/api\.getProgress\(versionId\)/);
    expect(page).toMatch(/progressState = 'unavailable'/);
    expect(page).toMatch(/progressState = progress \? 'present' : 'none'/);
    expect(page).toMatch(/initialProgress=\{progress\}/);
    expect(page).toMatch(/progressState=\{progressState\}/);
    // The progress read lives outside the document-fetch try block, so a
    // failure degrades the prompt instead of rendering notFound().
    const docFetch = page.indexOf('api.getVersion(versionId)');
    const progressFetch = page.indexOf('api.getProgress(versionId)');
    expect(progressFetch).toBeGreaterThan(docFetch);
  });

  it('exposes the progress read on the shared API client', () => {
    const api = apiSource();
    expect(api).toMatch(/getProgress: \(versionId: string\)/);
    expect(api).toMatch(/\/api\/documents\/\$\{versionId\}\/progress/);
    // Writes go through the browser-only coalescing saver, which must attach
    // the ordering guard; there is no second, unguarded PUT path.
    expect(api).not.toMatch(/saveProgress/);
  });

  it('renders the resume choice inside the document, after the header', () => {
    const src = readerSource();
    const header = src.indexOf('<header className="doc-header">');
    const strip = src.indexOf('<div className="resume-strip"');
    const docClose = src.indexOf('</article>');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(strip).toBeGreaterThan(header);
    expect(strip).toBeLessThan(docClose);
    expect(src).toMatch(/data-testid="resume-reading"/);
    expect(src).toMatch(/data-testid="start-from-beginning"/);
    expect(src).toMatch(/role="group" aria-label="Reading position"/);
  });

  it('never saves before the reader chooses, and never after a failed read', () => {
    const src = readerSource();
    const queue = bodyBetween(src, 'const queueCurrentPosition = useCallback', '}, [props.progressState]);');
    expect(queue).toMatch(/if \(!resumeDecidedRef\.current\) return;/);
    expect(queue).toMatch(/if \(props\.progressState === 'unavailable'\) return;/);

    // Scroll sampling is attached only once a choice has been made.
    const scrollEffect = bodyBetween(src, 'const onScroll = () => {', '}, [resumeDecided, props.progressState, queueCurrentPosition]);');
    expect(src).toMatch(/if \(!resumeDecided \|\| props\.progressState === 'unavailable'\) return;/);
    expect(scrollEffect).toMatch(/queueCurrentPosition\(\)/);
  });

  it('keeps the movement threshold for scroll sampling but not for unload samples', () => {
    const src = readerSource();
    const queue = bodyBetween(src, 'const queueCurrentPosition = useCallback', '}, [props.progressState]);');
    // The unload sample bypasses only the threshold: an identical current
    // position must still be dispatched with keepalive because the matching
    // normal request may be dropped during unload.
    expect(queue).toMatch(/if \(!keepalive && !shouldQueueProgress\(lastQueuedProgress\.current, sample\)\) return;/);
    expect(queue).toMatch(/lastQueuedProgress\.current = sample;/);
    expect(queue).toMatch(/save\(sample, \{ keepalive \}\)/);
    // No unconditional dedupe left behind.
    expect(queue).not.toMatch(/if \(!shouldQueueProgress/);
  });

  it('resume restores without writing, beginning writes passage one at ratio zero', () => {
    const src = readerSource();
    const resume = bodyBetween(src, 'const resumeFromProgress = useCallback', 'const startReadingFromBeginning = useCallback');
    expect(resume).toMatch(/setResumeDecided\(true\)/);
    expect(resume.indexOf('setResumeDecided(true)')).toBeLessThan(resume.indexOf('restoreProgress('));
    expect(resume).not.toMatch(/progressSaver/);

    const beginning = bodyBetween(
      src,
      'const saveBeginningAndScroll = useCallback',
      'const resumeFromProgress = useCallback',
    );
    expect(beginning).toMatch(/passageId: firstPassageId, offsetRatio: 0/);
    expect(beginning).toMatch(/progressSaver\.current\?\.save\(sample\)/);
    expect(beginning).toMatch(/scrollPageTo\(0\)/);

    // The visible "Start from beginning" control uses the same path.
    const handler = bodyBetween(
      src,
      'const startReadingFromBeginning = useCallback',
      '// Intentional article interaction',
    );
    expect(handler).toMatch(/setResumeDecided\(true\)/);
    expect(handler).toMatch(/resumeDecidedRef\.current = true/);
    expect(handler).toMatch(/saveBeginningAndScroll\(\)/);
  });

  it('falls back to the beginning when the saved passage is no longer rendered', () => {
    const src = readerSource();
    const restore = bodyBetween(src, 'const restoreProgress = useCallback', '// Beginning = first passage');
    // A missing anchor reports false instead of guessing a position.
    expect(restore).toMatch(/if \(!el\) return false;/);
    expect(restore).toMatch(/return true;/);

    const resume = bodyBetween(src, 'const resumeFromProgress = useCallback', 'const startReadingFromBeginning = useCallback');
    expect(resume).toMatch(/const restored = restoreProgress\(/);
    expect(resume).toMatch(/if \(restored\) return;/);
    // The fallback repairs the row at the beginning; it never persists a
    // guessed location and never reuses the stale anchor.
    expect(resume).toMatch(/saveBeginningAndScroll\(\)/);
    expect(resume).not.toMatch(/progressSaver/);
  });

  it('sends the per-reader-instance ordering guard with each save', () => {
    const src = readerSource();
    expect(src).toMatch(/\{ instanceId: createProgressInstanceId\(\) \}/);
    expect(src).toMatch(/instanceId: options\.instanceId/);
    expect(src).toMatch(/sequence: options\.sequence/);
  });

  it('keeps resume scrolling separate from the passage reveal helper', () => {
    const src = readerSource();
    const restore = bodyBetween(src, 'const restoreProgress = useCallback', '// Beginning = first passage');
    expect(restore).toMatch(/resumeScrollTop\(/);
    expect(restore).toMatch(/scrollPageTo\(/);
    expect(restore).not.toMatch(/scrollToPassage\(/);
    // Existing centered reveal contract is untouched (7 call sites elsewhere).
    expect(src).toMatch(/const scrollToPassage = useCallback\(\(passageId: string, block: 'center' \| 'start' = 'center'\)/);
  });

  it('samples only while the reading line crosses the document', () => {
    const src = readerSource();
    expect(src).toMatch(/isReadingLineInsideDoc\(container\.getBoundingClientRect\(\), lineY\)/);
    expect(src).toMatch(/passageAtLine\(bands, lineY\)/);
    expect(src).toMatch(/window\.innerHeight \* READING_LINE_RATIO/);
    // Binary search keeps measurement bounded on long documents.
    expect(src).toMatch(/let lo = 0;\s*let hi = elements\.length - 1;/);
  });

  it('honours reduced motion and leaves browser scroll restoration as it was', () => {
    const src = readerSource();
    const scroll = bodyBetween(src, 'const scrollPageTo = useCallback', '// Inverse of sampling');
    expect(scroll).toMatch(/prefersReducedMotion\(\)/);
    expect(scroll).toMatch(/behavior: smooth \? 'smooth' : 'auto'/);

    const restoration = bodyBetween(src, 'Browser scroll restoration would compete', '}, []);');
    expect(src).toMatch(/const previous = history\.scrollRestoration/);
    expect(src).toMatch(/history\.scrollRestoration = 'manual'/);
    expect(restoration).toMatch(/history\.scrollRestoration = previous/);
  });

  it('flushes on pagehide, hidden tabs, and unmount with keepalive and disposal', () => {
    const src = readerSource();
    expect(src).toMatch(/window\.addEventListener\('pagehide', onPageHide\)/);
    expect(src).toMatch(/document\.addEventListener\('visibilitychange', onVisibility\)/);
    expect(src).toMatch(/document\.visibilityState === 'hidden'/);
    expect(src).toMatch(/queueCurrentPosition\(true\)/);
    expect(src).toMatch(/flush\(\{ keepalive: true \}\)/);
    expect(src).toMatch(/saver\.flush\(\)/);
    expect(src).toMatch(/saver\.dispose\(\)/);
    // The first sample is throttled, not one request per scroll event.
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*progressSampleTimer\.current = null;/);
  });

  it('creates the saver per effect setup so a Strict Mode replay cannot inherit a disposed one', () => {
    const src = readerSource();
    // Never created during render into the shared ref.
    expect(src).not.toMatch(/progressSaver\.current = createProgressSaver/);

    const setup = bodyBetween(src, 'const saver = createProgressSaver(', 'progressSaver.current = saver;');
    expect(setup).toMatch(/instanceId: createProgressInstanceId\(\)/);
    expect(setup).toMatch(/instanceId: options\.instanceId/);
    expect(setup).toMatch(/sequence: options\.sequence/);

    const cleanup = bodyBetween(
      src,
      'progressSaver.current = saver;',
      '}, [versionId, queueCurrentPosition, finishRestore]);',
    );
    // Real unmount persists the last position, then disposes only this setup.
    expect(cleanup).toMatch(/queueCurrentPosition\(\)/);
    expect(cleanup).toMatch(/saver\.flush\(\)/);
    expect(cleanup.indexOf('saver.flush()'))
      .toBeLessThan(cleanup.indexOf('saver.dispose()'));
    expect(cleanup).toMatch(/if \(progressSaver\.current === saver\) progressSaver\.current = null;/);
    // Timers and the scroll-settle listener are cleaned up.
    expect(cleanup).toMatch(/clearTimeout\(progressSampleTimer\.current\)/);
    expect(cleanup).toMatch(/clearTimeout\(restoreSettleTimer\.current\)/);
    expect(cleanup).toMatch(/removeEventListener\('scrollend', finishRestore\)/);
  });

  it('ignores programmatic scroll events for resume and start-over, with or without motion', () => {
    const src = readerSource();
    const scroll = bodyBetween(src, 'const scrollPageTo = useCallback', 'const saver = createProgressSaver(');
    // Opened unconditionally: reduced-motion instant jumps also count.
    expect(scroll).toMatch(/restoringPosition\.current = true;/);
    expect(scroll).not.toMatch(/if \(smooth\) \{\s*restoringPosition/);
    // A sample already scheduled by an earlier scroll is cancelled.
    expect(scroll).toMatch(/clearTimeout\(progressSampleTimer\.current\)/);
    expect(scroll).toMatch(/smooth \? 700 : 400/);
    expect(scroll).toMatch(/addEventListener\('scrollend', finishRestore/);

    const onScroll = bodyBetween(src, 'const onScroll = () => {', "window.addEventListener('scroll', onScroll");
    expect(onScroll).toMatch(/if \(restoringPosition\.current\) return;/);

    // Start from beginning still writes first passage / 0 before scrolling.
    const beginning = bodyBetween(
      src,
      'const saveBeginningAndScroll = useCallback',
      'const resumeFromProgress = useCallback',
    );
    expect(beginning).toMatch(/offsetRatio: 0/);
    expect(beginning.indexOf('progressSaver.current?.save(sample)'))
      .toBeLessThan(beginning.indexOf('scrollPageTo(0)'));
  });

  it('styling reuses existing tokens with no decorative motion', () => {
    const css = cssSource();
    const rule = bodyBetween(css, '.resume-strip {', '}');
    expect(rule).toMatch(/background: var\(--surface-hover\)/);
    expect(rule).toMatch(/border: 1px solid var\(--border-subtle\)/);
    expect(rule).toMatch(/border-radius: 6px/);
    expect(rule).not.toMatch(/gradient|transform|box-shadow/);
    expect(css).toMatch(/\.resume-strip-actions \.btn-ghost \{ width: 100%; \}/);
  });
});
