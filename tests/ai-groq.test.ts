import { describe, expect, it } from 'vitest';
import {
  GroqProvider, HttpProviderAdapter, ModelRouter,
  quantile, summarizeLatencyRuns,
} from '@bhasya/ai';
import type { ExplainInput } from '@bhasya/ai';
import { ingestSample, makeServices, scrubProviderEnv } from './helpers.js';
import { resolveAnchor, streamExplainSelection } from '../apps/api/src/services.js';

const BASE_INPUT: ExplainInput = {
  selection: 'rarest and purest form of generosity',
  nearbyContext: ['Attention is the rarest and purest form of generosity.'],
  userRequest: 'what does this mean in practice?',
  title: 'The Craft of Reading',
  history: [
    { role: 'user', content: 'Explain this passage.' },
    { role: 'assistant', content: 'Prior answer.' },
  ],
};

const deltaFrame = (text: string): string =>
  JSON.stringify({ choices: [{ delta: { content: text } }] });

/** OpenAI-compatible SSE Response, optionally fragmented mid-frame. */
function groqSse(frames: string[], opts: { status?: number; withDone?: boolean; splitEvery?: number } = {}): Response {
  const raw = frames.map((f) => `data: ${f}\n\n`).join('') + (opts.withDone ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(raw);
  const every = opts.splitEvery ?? Math.max(1, Math.floor(bytes.length / 2));
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += every) parts.push(bytes.slice(i, i + every));
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i < parts.length) c.enqueue(parts[i++]);
      else c.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
}

function recordingGroq(text: string, extraOpts: Record<string, unknown> = {}): {
  provider: GroqProvider; urls: string[]; bodies: any[]; headers: any[];
} {
  const urls: string[] = [];
  const bodies: any[] = [];
  const headers: any[] = [];
  const fetchFn = (async (url: unknown, init: any) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers);
    return groqSse([deltaFrame(text)]);
  }) as unknown as typeof fetch;
  return {
    urls, bodies, headers,
    provider: new GroqProvider({ apiKey: 'groq-secret-xyz', fetchFn, ...(extraOpts as any) }),
  };
}

async function drainGroq(provider: GroqProvider, input: ExplainInput): Promise<{ acc: string; done: string }> {
  let acc = '';
  let done = '';
  for await (const item of provider.streamExplain(input)) {
    if (item.kind === 'chunk') acc += item.text;
    else done = item.text;
  }
  return { acc, done };
}

describe('Groq request mapping', () => {
  it('maps system, history roles, and the grounded turn like the OpenRouter path', async () => {
    const { bodies, provider } = recordingGroq('ok');
    await drainGroq(provider, BASE_INPUT);
    const body = bodies[0];
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    expect(body.messages[0].content).toContain('passage');
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages[1].content).toBe('Explain this passage.');
    expect(body.messages[2].content).toBe('Prior answer.');
    const last = body.messages[3].content as string;
    expect(last).toContain('rarest and purest form of generosity');
    expect(last).toContain('what does this mean in practice?');
    expect(body.temperature).toBe(0.3);
  });

  it('posts to the Groq chat completions endpoint for both paths', async () => {
    const { urls, provider } = recordingGroq('ok');
    await drainGroq(provider, BASE_INPUT);
    expect(urls[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    const urls2: string[] = [];
    const fetchFn = (async (url: unknown) => {
      urls2.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await new GroqProvider({ apiKey: 'k', fetchFn }).explain(BASE_INPUT);
    expect(urls2[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('sends the bearer key header without ever logging it', async () => {
    const { headers, provider } = recordingGroq('ok');
    await drainGroq(provider, BASE_INPUT);
    expect(headers[0].authorization).toBe('Bearer groq-secret-xyz');
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: 'rarest and purest form of generosity' });
      svc.router = new ModelRouter(provider);
      await streamExplainSelection(svc, identity, { anchorId: anchor.anchorId }, async () => {});
      const rows = (await svc.db.query(`SELECT metadata FROM event_log WHERE resource_type = 'thread'`, [])).rows as any[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(JSON.stringify(r.metadata)).not.toContain('groq-secret-xyz');
      }
    } finally {
      await cleanup();
    }
  });

  it('verified low-effort reasoning, excluded output, bounded completion', async () => {
    // Verified against Groq docs for openai/gpt-oss-20b: reasoning_effort
    // low|medium|high ('none' is Qwen-only); reasoning_format unsupported
    // for GPT-OSS so include_reasoning:false is the exclusion knob.
    const { bodies, provider } = recordingGroq('ok');
    await drainGroq(provider, BASE_INPUT);
    expect(bodies[0].reasoning_effort).toBe('low');
    expect(bodies[0].include_reasoning).toBe(false);
    expect(bodies[0].reasoning_format).toBeUndefined();
    expect(bodies[0].max_completion_tokens).toBe(768);
    expect(bodies[0].max_tokens).toBeUndefined();
    expect(bodies[0].stream).toBe(true);
  });
});

describe('Groq streaming over OpenAI-compatible SSE', () => {
  it('accumulates fragmented frames and completes with the full text', async () => {
    const fetchFn = (async () =>
      groqSse([deltaFrame('Hel'), 'broken{{{', deltaFrame('lo'), deltaFrame(' world')], { withDone: true })
    ) as unknown as typeof fetch;
    const provider = new GroqProvider({ apiKey: 'k', fetchFn });
    const { acc, done } = await drainGroq(provider, BASE_INPUT);
    expect(acc).toBe('Hello world');
    expect(done).toBe('Hello world');
  });

  it('accumulation equals explain() text through the same mapping', async () => {
    const full = 'First paragraph.\n\nSecond paragraph with detail.';
    const { provider } = recordingGroq(full);
    const { acc, done } = await drainGroq(provider, BASE_INPUT);
    expect(acc).toBe(full);
    expect(done).toBe(full);
    const jsonFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: full } }] }), { status: 200 })
    ) as unknown as typeof fetch;
    const out = await new GroqProvider({ apiKey: 'k', fetchFn: jsonFetch }).explain(BASE_INPUT);
    expect(out.text).toBe(full);
    expect(out.modelId).toBe('openai/gpt-oss-20b');
  });

  it('empty streams throw; upstream errors carry status', async () => {
    const empty = new GroqProvider({
      apiKey: 'k', fetchFn: (async () => groqSse([])) as unknown as typeof fetch,
    });
    await expect(drainGroq(empty, BASE_INPUT)).rejects.toThrow(/empty provider response/);
    const failing = new GroqProvider({
      apiKey: 'k', fetchFn: (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(drainGroq(failing, BASE_INPUT)).rejects.toThrow(/provider failed: 429/);
  });
});

describe('Groq provider selection, telemetry, and persistence', () => {
  it('BHASYA_PROVIDER=groq selects Groq; other paths are intact', async () => {
    // Hermetic: fromEnv falls through to process.env by design, so scrub the
    // shell to prove the default contract deterministically.
    const restore = scrubProviderEnv();
    try {
      expect(ModelRouter.fromEnv({}).adapterId).toBe('dev-grounded-1');
      expect((ModelRouter.fromEnv({ BHASYA_MODEL_API_KEY: 'k', BHASYA_MODEL_ID: 'm' }) as any).adapter)
        .toBeInstanceOf(HttpProviderAdapter);
      const groq = ModelRouter.fromEnv({ BHASYA_PROVIDER: 'groq', GROQ_API_KEY: 'k' });
      expect((groq as any).adapter).toBeInstanceOf(GroqProvider);
      expect(groq.adapterId).toBe('openai/gpt-oss-20b');
      // Missing Groq key falls back exactly like a missing OpenRouter key.
      expect(ModelRouter.fromEnv({ BHASYA_PROVIDER: 'groq' }).adapterId).toBe('dev-grounded-1');
      const custom = ModelRouter.fromEnv({
        BHASYA_PROVIDER: 'groq', GROQ_API_KEY: 'k', GROQ_MODEL_ID: 'custom-m',
        GROQ_MAX_TOKENS: '512', GROQ_REASONING_EFFORT: 'medium',
      });
      expect(custom.adapterId).toBe('custom-m');
      // Invalid effort falls back to verified low on the wire.
      const bad = ModelRouter.fromEnv({ BHASYA_PROVIDER: 'groq', GROQ_API_KEY: 'k', GROQ_REASONING_EFFORT: 'none' });
      expect(bad.adapterId).toBe('openai/gpt-oss-20b');
      const seen: any[] = [];
      const badAdapter = (bad as any).adapter as GroqProvider;
      (badAdapter as any).opts.fetchFn = (async (_u: unknown, init: any) => {
        seen.push(JSON.parse(String(init.body)));
        return groqSse([deltaFrame('ok')]);
      }) as unknown as typeof fetch;
      for await (const _ of badAdapter.streamExplain(BASE_INPUT)) { /* drain */ }
      expect(seen[0].reasoning_effort).toBe('low');
    } finally {
      restore();
    }
  });

  it('follow-up through Groq keeps history, telemetry, and the L0 citation', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const seen: ExplainInput[] = [];
      const { provider } = recordingGroq('Groq answer.');
      const orig = provider.streamExplain.bind(provider);
      (provider as any).streamExplain = async function* (input: ExplainInput) {
        seen.push({ ...input, history: [...(input.history ?? [])] });
        yield* orig(input);
      };
      svc.router = new ModelRouter(provider);
      const initial = await streamExplainSelection(svc, identity, { anchorId: anchor.anchorId }, async () => {});
      const Q = 'what does this mean in practice?';
      const events: any[] = [];
      const result = await streamExplainSelection(
        svc, identity, { anchorId: anchor.anchorId, question: Q, threadId: initial.threadId },
        async (ev) => { events.push(ev); },
      );
      expect(result.threadId).toBe(initial.threadId);
      expect(result.modelId).toBe('openai/gpt-oss-20b');
      expect(seen[1].selection).toBe(selA);
      expect(seen[1].userRequest).toBe(Q);
      expect(seen[1].history?.length).toBe(2);
      const done = events.find((e) => e.type === 'done');
      expect(done?.telemetry.provider).toBe('groq');
      expect(typeof done?.telemetry.ttftMs).toBe('number');
      expect(done?.result.text).toBe('Groq answer.');
      const msgs = (await svc.db.query(
        `SELECT role, content FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`, [initial.threadId],
      )).rows as any[];
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(String(msgs[3].content)).toBe('Groq answer.');
      const l0 = (await svc.db.query(
        `SELECT e.passage_id FROM citations c JOIN evidence e ON e.id = c.evidence_id
          JOIN thread_messages m ON m.id = e.thread_message_id
         WHERE m.id = $1 AND e.scope_level = 'L0'`, [result.assistantMessageId],
      )).rows as any[];
      expect(String(l0[0].passage_id)).toBe(anchor.passageId);
    } finally {
      await cleanup();
    }
  });
});

describe('latency summary math (harness reporting contract)', () => {
  it('quantile uses nearest-rank; empty is -1', () => {
    expect(quantile([], 0.5)).toBe(-1);
    expect(quantile([357, 462, 467, 527, 2345], 0.5)).toBe(467);
    expect(quantile([357, 462, 467, 527, 2345], 0.9)).toBe(2345);
    expect(quantile([10, 20], 0.5)).toBe(10);
  });

  it('summaries count ok/errors from the collection and ignore failed values', () => {
    const runs = [
      { kind: 'initial', ttftMs: 357, generationMs: 100, totalMs: 477 },
      { kind: 'initial', ttftMs: 462, generationMs: 110, totalMs: 576, error: 'HTTP 429' },
      { kind: 'initial', ttftMs: 467, generationMs: 109, totalMs: 576 },
      { kind: 'followup', ttftMs: 454, generationMs: 300, totalMs: 777 },
    ];
    const [initial, followup] = summarizeLatencyRuns(runs, ['initial', 'followup'], 3);
    expect(initial.ok).toBe(2);
    expect(initial.errors).toBe(1);
    expect(initial.ttftMed).toBe(357);
    expect(initial.totalMed).toBe(477);
    expect(followup.ok).toBe(1);
    expect(followup.errors).toBe(0);
    expect(followup.ttftMed).toBe(454);
  });

  it('empty collections report -1 rather than zeros', () => {
    const [s] = summarizeLatencyRuns([], ['initial'], 5);
    expect(s.ok).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.ttftMed).toBe(-1);
    expect(s.totalP90).toBe(-1);
  });
});
