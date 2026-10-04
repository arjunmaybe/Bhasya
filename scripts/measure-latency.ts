/** Bhasya provider latency probe (real key required).
 *
 * Runs fixed eval fixtures (initial + follow-up shapes) through the real
 * streaming provider path and reports TTFT / generation / total plus model,
 * provider, and token estimates — never prompts, responses, or content.
 *
 * Usage:
 *   BHASYA_MODEL_API_KEY=... BHASYA_MODEL_ID=<pinned-id> npx tsx scripts/measure-latency.ts
 *   BHASYA_MEASURE_ROUNDS=5  (default 5 initial + 5 follow-up)
 *
 * The model id is intentionally explicit: this harness never auto-routes.
 */
import { ModelRouter, estimateExplainInputSize } from '../packages/ai/src/providers.js';
import { summarizeLatencyRuns } from '../packages/ai/src/latency.js';
import type { ExplainInput } from '../packages/ai/src/providers.js';

const providerName: string = (process.env.BHASYA_PROVIDER ?? 'openrouter').toLowerCase();
const apiKey: string = providerName === 'gemini'
  ? (process.env.GEMINI_API_KEY ?? '')
  : providerName === 'groq'
    ? (process.env.GROQ_API_KEY ?? '')
    : (process.env.BHASYA_MODEL_API_KEY ?? '');
const configuredModel: string = providerName === 'gemini'
  ? (process.env.GEMINI_MODEL_ID ?? 'gemini-3.1-flash-lite')
  : providerName === 'groq'
    ? (process.env.GROQ_MODEL_ID ?? 'openai/gpt-oss-20b')
    : (process.env.BHASYA_MODEL_ID ?? '');
if (!apiKey || !configuredModel) {
  console.error('measure-latency: set BHASYA_MODEL_API_KEY and an explicit BHASYA_MODEL_ID first (or BHASYA_PROVIDER=gemini with GEMINI_API_KEY, or BHASYA_PROVIDER=groq with GROQ_API_KEY).');
  process.exit(2);
}
const modelId: string = configuredModel;
const ROUNDS = Math.max(1, Number.parseInt(process.env.BHASYA_MEASURE_ROUNDS ?? '5', 10) || 5);
const TIMEOUT_MS = 120000;

// Fixed fixtures: identical shapes/inputs for every candidate model so runs
// are comparable. Representative of real Bhasya traffic (63/167 tok scale).
const PASSAGE_A = 'Attention is the rarest and purest form of generosity. To attend fully to a passage is to give it time.';
const PASSAGE_B = 'Distraction, by contrast, fractures the mind into small tradable pieces.';
const initialInput: ExplainInput = {
  selection: 'rarest and purest form of generosity',
  nearbyContext: [PASSAGE_A, PASSAGE_B],
  userRequest: 'Explain this passage.',
  title: 'The Craft of Reading',
  history: [],
};
const followupInput: ExplainInput = {
  ...initialInput,
  userRequest: 'what does this mean in practice?',
  history: [
    { role: 'user', content: 'Explain this passage.' },
    { role: 'assistant', content: 'This passage says attention is generous. Placeholder prior answer.' },
  ],
};

interface Run {
  kind: string; ttftMs: number; generationMs: number; totalMs: number;
  model: string; provider: string; inputTok: number; outputTok: number;
  truncated: boolean; error?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runOnce(kind: string, input: ExplainInput): Promise<Run> {
  const router = ModelRouter.fromEnv();
  const size = estimateExplainInputSize(input);
  const started = Date.now();
  let ttftMs = -1;
  let acc = '';
  let model = '';
  let provider = 'not-reported';
  let truncated = false;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`TIMEOUT after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });
  const attempt = (async (): Promise<void> => {
    for await (const item of router.streamExplain(input)) {
      if (item.kind === 'chunk') {
        if (ttftMs < 0 && item.text.length > 0) ttftMs = Date.now() - started;
        acc += item.text;
      } else {
        acc = item.text.length > 0 ? item.text : acc;
        model = item.modelId;
        if (item.provider) provider = item.provider;
      }
    }
  })();
  try {
    await Promise.race([attempt, timeout]);
  } catch (e) {
    return {
      kind, ttftMs: -1, generationMs: -1, totalMs: Date.now() - started,
      model: modelId, provider, inputTok: size.inputTokenEstimate,
      outputTok: Math.max(1, Math.ceil(acc.length / 4)), truncated: true,
      error: e instanceof Error ? `${e.name}: ${(e.message ?? '').slice(0, 120)}` : 'error',
    };
  }
  const totalMs = Date.now() - started;
  if (ttftMs < 0) ttftMs = totalMs;
  return {
    kind, ttftMs, generationMs: Math.max(0, totalMs - ttftMs), totalMs,
    model: model || modelId, provider, inputTok: size.inputTokenEstimate,
    outputTok: Math.max(1, Math.ceil(acc.length / 4)), truncated,
  };
}

const runs: Run[] = [];
for (let i = 0; i < ROUNDS; i += 1) {
  runs.push(await runOnce('initial', initialInput));
  console.log(`run ${i + 1}a/${ROUNDS} initial: ttft=${runs[runs.length - 1].ttftMs}ms total=${runs[runs.length - 1].totalMs}ms model=${runs[runs.length - 1].model} provider=${runs[runs.length - 1].provider} inTok~${runs[runs.length - 1].inputTok} outTok~${runs[runs.length - 1].outputTok}${runs[runs.length - 1].error ? ` ERROR=${runs[runs.length - 1].error}` : ''}`);
  await sleep(1000);
  runs.push(await runOnce('followup', followupInput));
  console.log(`run ${i + 1}b/${ROUNDS} followup: ttft=${runs[runs.length - 1].ttftMs}ms total=${runs[runs.length - 1].totalMs}ms model=${runs[runs.length - 1].model} provider=${runs[runs.length - 1].provider} inTok~${runs[runs.length - 1].inputTok} outTok~${runs[runs.length - 1].outputTok}${runs[runs.length - 1].error ? ` ERROR=${runs[runs.length - 1].error}` : ''}`);
  await sleep(1000);
}

for (const s of summarizeLatencyRuns(runs, ['initial', 'followup'], ROUNDS)) {
  console.log(`summary ${s.kind}: n=${s.ok}/${s.rounds} errors=${s.errors} ` +
    `ttft_med=${s.ttftMed} ttft_p90=${s.ttftP90} ` +
    `gen_med=${s.genMed} gen_p90=${s.genP90} ` +
    `total_med=${s.totalMed} total_p90=${s.totalP90}`);
}
