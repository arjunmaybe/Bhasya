/**
 * Shared latency-summary math for measurement harnesses.
 * Pure functions (no I/O, no content): successful runs are counted from the
 * results collection itself, errors are counted separately, and median/p90
 * use nearest-rank over the successful values only. Unit-tested; the
 * measure-latency script reports through these helpers so a broken local
 * summary calculation cannot silently ship zeros again.
 */
export interface LatencyRun {
  kind: string;
  ttftMs: number;
  generationMs: number;
  totalMs: number;
  error?: string;
}

export interface LatencySummary {
  kind: string;
  rounds: number;
  ok: number;
  errors: number;
  ttftMed: number;
  ttftP90: number;
  genMed: number;
  genP90: number;
  totalMed: number;
  totalP90: number;
}

/** Nearest-rank quantile over an already-sorted ascending array. Empty → -1. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return -1;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function summarizeLatencyRuns(runs: LatencyRun[], kinds: string[], rounds: number): LatencySummary[] {
  return kinds.map((kind) => {
    const ok = runs.filter((r) => r.kind === kind && !r.error);
    const pick = (f: (r: LatencyRun) => number): number[] =>
      ok.map(f).filter((n) => typeof n === 'number' && n >= 0).sort((a, b) => a - b);
    const ttft = pick((r) => r.ttftMs);
    const gen = pick((r) => r.generationMs);
    const tot = pick((r) => r.totalMs);
    return {
      kind,
      rounds,
      ok: ok.length,
      errors: runs.filter((r) => r.kind === kind && r.error).length,
      ttftMed: quantile(ttft, 0.5),
      ttftP90: quantile(ttft, 0.9),
      genMed: quantile(gen, 0.5),
      genP90: quantile(gen, 0.9),
      totalMed: quantile(tot, 0.5),
      totalP90: quantile(tot, 0.9),
    };
  });
}
