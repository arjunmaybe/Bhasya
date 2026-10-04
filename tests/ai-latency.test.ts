import { describe, expect, it } from 'vitest';
import { HttpProviderAdapter, ModelRouter } from '@bhasya/ai';
import type { ExplainInput } from '@bhasya/ai';
import { ingestSample, makeServices, scrubProviderEnv } from './helpers.js';
import { resolveAnchor, streamExplainSelection } from '../apps/api/src/services.js';

const BASE_INPUT: ExplainInput = {
  selection: 'rarest and purest form of generosity',
  nearbyContext: ['Attention is the rarest and purest form of generosity.'],
  userRequest: 'what does this mean in practice?',
  title: 'The Craft of Reading',
  history: [{ role: 'user', content: 'Explain this passage.' }],
};

function sseTextResponse(text: string): Response {
  const frames = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`, 'data: [DONE]\n\n'].join('');
  const bytes = new TextEncoder().encode(frames);
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i === 0) { c.enqueue(bytes); i += 1; }
      else c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Builds an Http adapter that records request bodies and serves canned text. */
function recordingAdapter(text = 'streamed answer', extraOpts: Record<string, unknown> = {}): {
  adapter: HttpProviderAdapter; bodies: any[];
} {
  const bodies: any[] = [];
  const fetchFn = (async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(String(init.body)));
    return sseTextResponse(text);
  }) as unknown as typeof fetch;
  return {
    bodies,
    adapter: new HttpProviderAdapter({ modelId: 'm', endpoint: 'https://x', apiKey: 'k', fetchFn, ...(extraOpts as any) }),
  };
}

describe('latency preset: provider routing', () => {
  it('sorts by latency with fallbacks retained (never a random-model router)', async () => {
    const { bodies, adapter } = recordingAdapter();
    const input = { ...BASE_INPUT };
    for await (const _ of adapter.streamExplain(input)) { /* drain */ }
    expect(bodies.length).toBe(1);
    expect(bodies[0].model).toBe('m');
    expect(bodies[0].provider).toEqual({ sort: 'latency', allow_fallbacks: true });
    // Same preset on the complete/wait path.
    await adapter.explain(input).catch(() => {});
  });

  it('non-streaming explain carries the identical routing preset', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new HttpProviderAdapter({ modelId: 'm', endpoint: 'https://x', apiKey: 'k', fetchFn });
    await adapter.explain({ ...BASE_INPUT });
    expect(bodies[0].provider).toEqual({ sort: 'latency', allow_fallbacks: true });
    expect(bodies[0].stream).toBeUndefined();
  });

  it('env overrides routing sort and fallback retention', async () => {
    const restore = scrubProviderEnv();
    try {
      const router = ModelRouter.fromEnv({
        BHASYA_MODEL_API_KEY: 'k', BHASYA_MODEL_ID: 'm',
        BHASYA_MODEL_ENDPOINT: 'https://x', BHASYA_MODEL_PROVIDER_SORT: 'throughput',
        BHASYA_MODEL_ALLOW_FALLBACKS: '0',
      });
      const adapter = (router as any).adapter as HttpProviderAdapter;
      const seen: any[] = [];
      (adapter as any).opts.fetchFn = (async (_u: unknown, init: any) => {
        seen.push(JSON.parse(String(init.body)));
        return sseTextResponse('ok');
      }) as unknown as typeof fetch;
      for await (const _ of adapter.streamExplain({ ...BASE_INPUT })) { /* drain */ }
      expect(seen[0].provider).toEqual({ sort: 'throughput', allow_fallbacks: false });
    } finally {
      restore();
    }
  });
});

describe('latency preset: reasoning and completion bounds', () => {
  it('requests low reasoning effort excluded from output, with a bounded completion', async () => {
    const { bodies, adapter } = recordingAdapter();
    for await (const _ of adapter.streamExplain({ ...BASE_INPUT })) { /* drain */ }
    expect(bodies[0].reasoning).toEqual({ effort: 'low', exclude: true });
    expect(bodies[0].max_tokens).toBe(768);
  });

  it('bounded completions still arrive complete over streaming', async () => {
    const full = 'A'.repeat(2000);
    const { adapter } = recordingAdapter(full, { maxTokens: 768 });
    let acc = '';
    let doneText = '';
    for await (const item of adapter.streamExplain({ ...BASE_INPUT })) {
      if (item.kind === 'chunk') acc += item.text;
      else doneText = item.text;
    }
    expect(acc).toBe(full);
    expect(doneText).toBe(full);
  });

  it('reasoning=none omits reasoning control; invalid env falls back to defaults', async () => {
    const restore = scrubProviderEnv();
    try {
      const mkRouter = (env: Record<string, unknown>): HttpProviderAdapter => {
        const r = ModelRouter.fromEnv({ BHASYA_MODEL_API_KEY: 'k', BHASYA_MODEL_ID: 'm', BHASYA_MODEL_ENDPOINT: 'https://x', ...env });
        return (r as any).adapter as HttpProviderAdapter;
      };
      const capture = async (adapter: HttpProviderAdapter): Promise<any> => {
        const seen: any[] = [];
        (adapter as any).opts.fetchFn = (async (_u: unknown, init: any) => {
          seen.push(JSON.parse(String(init.body)));
          return sseTextResponse('ok');
        }) as unknown as typeof fetch;
        for await (const _ of adapter.streamExplain({ ...BASE_INPUT })) { /* drain */ }
        return seen[0];
      };
      expect((await capture(mkRouter({ BHASYA_MODEL_REASONING_EFFORT: 'none' }))).reasoning).toBeUndefined();
      const bad = await capture(mkRouter({ BHASYA_MODEL_REASONING_EFFORT: 'turbo-ultra', BHASYA_MODEL_MAX_TOKENS: 'abc', BHASYA_MODEL_PROVIDER_SORT: 'vibes' }));
      expect(bad.reasoning).toEqual({ effort: 'low', exclude: true });
      expect(bad.max_tokens).toBe(768);
      expect(bad.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
      const custom = await capture(mkRouter({ BHASYA_MODEL_MAX_TOKENS: '512', BHASYA_MODEL_INCLUDE_REASONING: '1' }));
      expect(custom.max_tokens).toBe(512);
      expect(custom.reasoning).toEqual({ effort: 'low', exclude: false });
    } finally {
      restore();
    }
  });
});

describe('qwen/qwen3.8-27b:free minimal-thinking request shape (verified)', () => {
  // Verified against the live OpenRouter catalog (models API, 2026-10-04):
  // reasoning { mandatory: false, default_enabled: true,
  //   supported_efforts: ["xhigh","medium","low"], default_effort: "xhigh" }.
  // 'low' is therefore the lowest verified effort (default xhigh would
  // maximize pre-token thinking); 'none'/token-budget shapes are not listed
  // and must not be sent. exclude:true is universal per OpenRouter docs.
  it('streams with low excluded reasoning, usage reporting, and latency routing', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseTextResponse('ok answer');
    }) as unknown as typeof fetch;
    const adapter = new HttpProviderAdapter({
      modelId: 'qwen/qwen3.8-27b:free', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'k', fetchFn,
    });
    let acc = '';
    let doneText = '';
    for await (const item of adapter.streamExplain({ ...BASE_INPUT })) {
      if (item.kind === 'chunk') acc += item.text;
      else doneText = item.text;
    }
    expect(bodies.length).toBe(1);
    const body = bodies[0];
    expect(body.model).toBe('qwen/qwen3.8-27b:free');
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
    expect(body.max_tokens).toBe(768);
    // No unverified shapes for this model: no off-value, no token budget,
    // no top-level reasoning_effort passthrough, no legacy flag.
    expect(body.reasoning.effort).not.toBe('none');
    expect(body.reasoning.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.include_reasoning).toBeUndefined();
    // Stream still completes fully.
    expect(acc).toBe('ok answer');
    expect(doneText).toBe('ok answer');
  });

  it('non-streaming explain carries the same minimal-thinking shape', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new HttpProviderAdapter({
      modelId: 'qwen/qwen3.8-27b:free', endpoint: 'https://x', apiKey: 'k', fetchFn,
    });
    await adapter.explain({ ...BASE_INPUT });
    expect(bodies[0].reasoning).toEqual({ effort: 'low', exclude: true });
    expect(bodies[0].stream).toBeUndefined();
    expect(bodies[0].provider).toEqual({ sort: 'latency', allow_fallbacks: true });
  });
});

describe('google/gemini-3.1-flash-lite minimal-thinking request shape (verified)', () => {
  // Verified against the live OpenRouter catalog (models API, 2026-10-04):
  // reasoning { mandatory: false, default_enabled: true,
  //   supported_efforts: ["high","medium","low","minimal"],
  //   default_effort: "minimal" }.
  // Bhasya explicitly sends effort 'low' (present in the list) with excluded
  // reasoning text — the same model-agnostic preset as every other model, so
  // no per-model branching is required for correctness here.
  const GEMINI_ID = 'google/gemini-3.1-flash-lite';
  it('streams with low excluded reasoning, usage reporting, and latency routing', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseTextResponse('grounded answer');
    }) as unknown as typeof fetch;
    const adapter = new HttpProviderAdapter({
      modelId: GEMINI_ID, endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'k', fetchFn,
    });
    let acc = '';
    let doneText = '';
    for await (const item of adapter.streamExplain({ ...BASE_INPUT })) {
      if (item.kind === 'chunk') acc += item.text;
      else doneText = item.text;
    }
    expect(bodies.length).toBe(1);
    const body = bodies[0];
    expect(body.model).toBe(GEMINI_ID);
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
    expect(body.max_tokens).toBe(768);
    // Grounding/history construction is model-independent.
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.messages[0]).toMatchObject({ role: 'system' });
    // Stream still completes fully.
    expect(acc).toBe('grounded answer');
    expect(doneText).toBe('grounded answer');
  });

  it('non-streaming explain carries the same minimal-thinking shape', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new HttpProviderAdapter({
      modelId: GEMINI_ID, endpoint: 'https://x', apiKey: 'k', fetchFn,
    });
    await adapter.explain({ ...BASE_INPUT, history: [{ role: 'user', content: 'Explain this passage.' }] });
    expect(bodies[0].reasoning).toEqual({ effort: 'low', exclude: true });
    expect(bodies[0].stream).toBeUndefined();
    expect(bodies[0].provider).toEqual({ sort: 'latency', allow_fallbacks: true });
    // Follow-up history shape is preserved for Gemini exactly as for Qwen.
    const userTurns = bodies[0].messages.filter((m: any) => m.role === 'user');
    expect(userTurns.length).toBe(2);
  });
});

describe('latency preset preserves grounding, history, and persistence', () => {
  it('follow-up through the HTTP adapter keeps history and L0 citation with telemetry', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const seen: ExplainInput[] = [];
      const bodies: any[] = [];
      const fetchFn = (async (_url: unknown, init: any) => {
        bodies.push(JSON.parse(String(init.body)));
        const text = `Answer about ${JSON.parse(String(init.body)).messages.length} messages.`;
        return sseTextResponse(text);
      }) as unknown as typeof fetch;
      const adapter = new HttpProviderAdapter({ modelId: 'preset-m', endpoint: 'https://x', apiKey: 'k', fetchFn });
      const orig = adapter.streamExplain.bind(adapter);
      (adapter as any).streamExplain = async function* (input: ExplainInput) {
        seen.push({ ...input, history: [...(input.history ?? [])] });
        yield* orig(input);
      };
      svc.router = new ModelRouter(adapter);
      const initial = await streamExplainSelection(svc, identity, { anchorId: anchor.anchorId }, async () => {});
      const Q = 'what does this mean in practice?';
      const events: any[] = [];
      const result = await streamExplainSelection(
        svc, identity, { anchorId: anchor.anchorId, question: Q, threadId: initial.threadId },
        async (ev) => { events.push(ev); },
      );
      // Preset present on the wire for both calls.
      expect(bodies.length).toBe(2);
      for (const b of bodies) {
        expect(b.provider).toEqual({ sort: 'latency', allow_fallbacks: true });
        expect(b.reasoning).toEqual({ effort: 'low', exclude: true });
        expect(b.max_tokens).toBe(768);
      }
      // History/thread semantics unchanged.
      expect(result.threadId).toBe(initial.threadId);
      expect(seen[1].history?.length).toBe(2);
      expect(seen[1].userRequest).toBe(Q);
      const done = events.find((e) => e.type === 'done');
      expect(done?.telemetry.modelId).toBe('preset-m');
      expect(typeof done?.telemetry.ttftMs).toBe('number');
      const l0 = (await svc.db.query(
        `SELECT e.passage_id FROM citations c JOIN evidence e ON e.id = c.evidence_id
          JOIN thread_messages m ON m.id = e.thread_message_id
         WHERE m.id = $1 AND e.scope_level = 'L0'`, [result.assistantMessageId],
      )).rows as any[];
      expect(String(l0[0].passage_id)).toBe(anchor.passageId);
      const msgs = (await svc.db.query(
        `SELECT role FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`, [initial.threadId],
      )).rows as any[];
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    } finally {
      await cleanup();
    }
  });
});
