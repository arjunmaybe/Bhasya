import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createStreamLane,
  laneBegin,
  laneCancel,
  laneIsCurrent,
  laneSettle,
} from '../apps/web/lib/stream-lane.js';

/**
 * Reader streaming cancellation regression (frontend-only).
 *
 * The Reader previously funneled Explain and follow-up SSE streams through
 * ONE shared AbortController ref with `isCurrent()` silent returns, so any
 * controller churn silently discarded an in-flight request with no answer
 * and no error (Explain flashing "Explaining" then resetting; follow-ups
 * vanishing). Each flow now owns an independent lane, intentional
 * cancellation stays silent, and genuine failures keep the error/fallback
 * path. No DOM harness exists in this repo, so coverage is pure unit tests
 * for the lane state machine plus source-contract tests in the repo's
 * established readFileSync idiom.
 */

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');

describe('stream lanes are independent (unit)', () => {
  it('begin on one lane never touches the other lane', () => {
    const explain = createStreamLane();
    const followup = createStreamLane();
    const ctrl = laneBegin(explain);
    expect(laneIsCurrent(explain, ctrl)).toBe(true);
    expect(followup.ctrl).toBe(null);
    expect(followup.cancelled).toBe(false);
    const ctrl2 = laneBegin(followup);
    expect(laneIsCurrent(followup, ctrl2)).toBe(true);
    // The first lane is still current: concurrent flows coexist.
    expect(laneIsCurrent(explain, ctrl)).toBe(true);
  });

  it('intentional cancellation is remembered and releases the lane', () => {
    const lane = createStreamLane();
    const ctrl = laneBegin(lane);
    expect(ctrl.signal.aborted).toBe(false);
    laneCancel(lane);
    expect(lane.cancelled).toBe(true);
    expect(lane.ctrl).toBe(null);
    expect(ctrl.signal.aborted).toBe(true);
    expect(laneIsCurrent(lane, ctrl)).toBe(false);
  });

  it('a superseding begin invalidates the previous controller without cancelling', () => {
    const lane = createStreamLane();
    const first = laneBegin(lane);
    const second = laneBegin(lane);
    // Stale completion must be ignorable, but this was NOT an intentional
    // cancellation: no abort was issued.
    expect(laneIsCurrent(lane, first)).toBe(false);
    expect(laneIsCurrent(lane, second)).toBe(true);
    expect(lane.cancelled).toBe(false);
    expect(first.signal.aborted).toBe(false);
  });

  it('settle releases only the owning controller', () => {
    const lane = createStreamLane();
    const first = laneBegin(lane);
    // A foreign controller (e.g. a newer flow) must not release this lane.
    laneSettle(lane, null);
    expect(lane.ctrl).toBe(first);
    const second = laneBegin(lane);
    laneSettle(lane, first);
    expect(lane.ctrl).toBe(second);
    laneSettle(lane, second);
    expect(lane.ctrl).toBe(null);
  });

  it('currency checks are null-safe (no TDZ/reference hazard)', () => {
    const lane = createStreamLane();
    expect(laneIsCurrent(lane, null)).toBe(false);
    laneCancel(lane);
    expect(laneIsCurrent(lane, null)).toBe(false);
  });
});

describe('ReaderClient cancellation ownership (source contract)', () => {
  it('Explain and follow-up own separate lanes; no shared ref remains', () => {
    const s = src();
    expect(s).toMatch(/const explainLane = useRef<StreamLane>\(createStreamLane\(\)\)/);
    expect(s).toMatch(/const followupLane = useRef<StreamLane>\(createStreamLane\(\)\)/);
    expect(s).not.toMatch(/streamAbortRef/);
  });

  it('each flow uses only its own lane', () => {
    const s = src();
    const explainBody = s.slice(s.indexOf('async function explain()'), s.indexOf('async function clickCitation'));
    const followupBody = s.slice(s.indexOf('async function sendFollowup'), s.indexOf('function handlePassageClick'));
    expect(explainBody).toMatch(/explainLane\.current/);
    expect(explainBody).not.toMatch(/followupLane/);
    expect(followupBody).toMatch(/followupLane\.current/);
    expect(followupBody).not.toMatch(/explainLane/);
  });

  it('Explain controller binding exists before the first await (TDZ-safe)', () => {
    const s = src();
    const body = s.slice(s.indexOf('async function explain()'), s.indexOf('async function clickCitation'));
    const decl = body.indexOf('let ctrl: AbortController | null = null');
    expect(decl).toBeGreaterThanOrEqual(0);
    // The anchor-resolution await comes after the binding declaration, so a
    // resolution failure reaches the error/fallback path instead of throwing
    // a secondary reference error inside the catch handler.
    expect(body.indexOf("await browserReq('/api/anchors/resolve'")).toBeGreaterThan(decl);
  });

  it('intentional cancellation stays silent only at unmount and thread close', () => {
    const s = src();
    // Unmount cleanup cancels both lanes.
    expect(s).toMatch(/laneCancel\(explainLane\.current\);\s*\n\s*laneCancel\(followupLane\.current\);/);
    // Thread close cancels both lanes.
    const clearBody = s.slice(s.indexOf('function clearThreadState()'), s.indexOf('async function exportPdf'));
    expect(clearBody).toMatch(/laneCancel\(explainLane\.current\)/);
    expect(clearBody).toMatch(/laneCancel\(followupLane\.current\)/);
    // Both stream error paths gate silence on the explicit cancelled flag —
    // a non-cancelled failure always reaches fallback/error instead.
    expect(s).toMatch(/if \(lane\.cancelled\)/);
  });

  it('non-stream fallback paths are preserved in both flows', () => {
    const s = src();
    const explainBody = s.slice(s.indexOf('async function explain()'), s.indexOf('async function clickCitation'));
    const followupBody = s.slice(s.indexOf('async function sendFollowup'), s.indexOf('function handlePassageClick'));
    expect(explainBody).toMatch(/\/api\/threads\/explain/);
    expect(followupBody).toMatch(/\/api\/threads\/\$\{threadId\}\/messages/);
  });
});
