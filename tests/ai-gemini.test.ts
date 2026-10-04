import { describe, expect, it } from 'vitest';
import {
  GoogleGeminiProvider, HttpProviderAdapter, ModelRouter,
  extractGeminiPayload,
} from '@bhasya/ai';
import type { ExplainInput, StreamItem } from '@bhasya/ai';
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

const geminiFrame = (parts: Array<{ text?: string; thought?: boolean }>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ candidates: [{ content: { parts, role: 'model' } }], ...extra });

/** Gemini SSE Response: data frames, then close (Gemini sends no [DONE]). */
function geminiSse(frames: string[], opts: { status?: number; withDone?: boolean; splitEvery?: number } = {}): Response {
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

function recordingGemini(text: string, extraOpts: Record<string, unknown> = {}): {
  provider: GoogleGeminiProvider; urls: string[]; bodies: any[]; headers: any[];
} {
  const urls: string[] = [];
  const bodies: any[] = [];
  const headers: any[] = [];
  const fetchFn = (async (url: unknown, init: any) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers);
    return geminiSse([geminiFrame([{ text }])]);
  }) as unknown as typeof fetch;
  return {
    urls, bodies, headers,
    provider: new GoogleGeminiProvider({ apiKey: 'gemini-secret-xyz', fetchFn, ...(extraOpts as any) }),
  };
}

async function drainStream(provider: GoogleGeminiProvider, input: ExplainInput): Promise<{ acc: string; done: string }> {
  let acc = '';
  let done = '';
  for await (const item of provider.streamExplain(input)) {
    if (item.kind === 'chunk') acc += item.text;
    else done = item.text;
  }
  return { acc, done };
}

describe('Gemini request mapping', () => {
  it('maps system instruction, history roles, and the grounded turn explicitly', async () => {
    const { bodies, provider } = recordingGemini('ok');
    await drainStream(provider, BASE_INPUT);
    const body = bodies[0];
    // System instruction carries the passage rule; no system role in contents.
    expect(body.systemInstruction.parts[0].text).toContain('passage');
    expect(body.contents.every((c: any) => c.role === 'user' || c.role === 'model')).toBe(true);
    // History order preserved with assistant mapped to model, then the request.
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[0].parts[0].text).toBe('Explain this passage.');
    expect(body.contents[1].parts[0].text).toBe('Prior answer.');
    const last = body.contents[2].parts[0].text as string;
    expect(last).toContain('rarest and purest form of generosity');
    expect(last).toContain('what does this mean in practice?');
    expect(last).toContain('Attention is the rarest');
  });

  it('uses the streamGenerateContent SSE URL for streams, plain JSON otherwise', async () => {
    const { urls, provider } = recordingGemini('ok');
    await drainStream(provider, BASE_INPUT);
    expect(urls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse');
    const urls2: string[] = [];
    const fetchFn = (async (url: unknown, init: any) => {
      urls2.push(String(url));
      void init;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p2 = new GoogleGeminiProvider({ apiKey: 'k', fetchFn });
    await p2.explain(BASE_INPUT);
    expect(urls2[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    expect(urls2[0]).not.toContain('alt=sse');
  });

  it('sends the API key header without ever logging it', async () => {
    const { headers, provider } = recordingGemini('ok');
    await drainStream(provider, BASE_INPUT);
    expect(headers[0]['x-goog-api-key']).toBe('gemini-secret-xyz');
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: 'rarest and purest form of generosity' });
      svc.router = new ModelRouter(provider);
      await streamExplainSelection(svc, identity, { anchorId: anchor.anchorId }, async () => {});
      const rows = (await svc.db.query(
        `SELECT metadata FROM event_log WHERE resource_type = 'thread'`, [],
      )).rows as any[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(JSON.stringify(r.metadata)).not.toContain('gemini-secret-xyz');
      }
    } finally {
      await cleanup();
    }
  });
});

describe('Gemini SSE parsing and accumulation', () => {
  it('parses multi-part frames, skips thought parts, tolerates [DONE]-less end', async () => {
    const fetchFn = (async () =>
      geminiSse([
        geminiFrame([{ text: 'Hel' }, { text: 'hidden-thought', thought: true }]),
        'broken{{{',
        geminiFrame([{ text: 'lo' }, { text: ' world' }]),
        JSON.stringify({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 5 } }),
      ])) as unknown as typeof fetch;
    const provider = new GoogleGeminiProvider({ apiKey: 'k', fetchFn });
    const { acc, done } = await drainStream(provider, BASE_INPUT);
    expect(acc).toBe('Hello world');
    expect(done).toBe('Hello world');
  });

  it('accumulation equals explain() text through the same mapping', async () => {
    const full = 'First paragraph.\n\nSecond paragraph with detail.';
    const { provider } = recordingGemini(full);
    const { acc, done } = await drainStream(provider, BASE_INPUT);
    expect(acc).toBe(full);
    expect(done).toBe(full);
    const jsonFetch = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: full }], role: 'model' } }] }), { status: 200 })
    ) as unknown as typeof fetch;
    const jsonProvider = new GoogleGeminiProvider({ apiKey: 'k', fetchFn: jsonFetch });
    const out = await jsonProvider.explain(BASE_INPUT);
    expect(out.text).toBe(full);
    expect(out.modelId).toBe('gemini-3.1-flash-lite');
  });

  it('extractGeminiPayload unit behavior: usage, blocked, malformed', () => {
    expect(extractGeminiPayload(geminiFrame([{ text: 'x' }]))?.text).toBe('x');
    expect(extractGeminiPayload('nope{{{')).toBeNull();
    expect(extractGeminiPayload(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))?.blocked).toBe('SAFETY');
    const usage = extractGeminiPayload(JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 7 } }));
    expect(usage?.promptTokens).toBe(3);
    expect(usage?.completionTokens).toBe(7);
  });

  it('empty streams throw; blocked responses name the reason; upstream errors carry status', async () => {
    const emptyProvider = new GoogleGeminiProvider({
      apiKey: 'k',
      fetchFn: (async () => geminiSse([])) as unknown as typeof fetch,
    });
    await expect(drainStream(emptyProvider, BASE_INPUT)).rejects.toThrow(/empty provider response/);
    const blockedProvider = new GoogleGeminiProvider({
      apiKey: 'k',
      fetchFn: (async () => geminiSse([JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })])) as unknown as typeof fetch,
    });
    await expect(drainStream(blockedProvider, BASE_INPUT)).rejects.toThrow(/blocked: SAFETY/);
    const failing = new GoogleGeminiProvider({
      apiKey: 'k',
      fetchFn: (async () => new Response('denied', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(drainStream(failing, BASE_INPUT)).rejects.toThrow(/provider failed: 503/);
  });
});

describe('Gemini reasoning configuration (verified minimal)', () => {
  it('defaults to thinkingLevel minimal with a bounded completion', async () => {
    const { bodies, provider } = recordingGemini('ok');
    await drainStream(provider, BASE_INPUT);
    expect(bodies[0].generationConfig).toMatchObject({
      temperature: 0.3,
      maxOutputTokens: 768,
      thinkingConfig: { thinkingLevel: 'minimal' },
    });
  });

  it('thinking level and bound are overridable; invalid falls back to minimal', async () => {
    const restore = scrubProviderEnv();
    try {
      const seen: any[] = [];
      const mk = (env: Record<string, unknown>): GoogleGeminiProvider => {
        const r = ModelRouter.fromEnv({ BHASYA_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', ...env });
        const p = (r as any).adapter as GoogleGeminiProvider;
        (p as any).opts.fetchFn = (async (_u: unknown, init: any) => {
          seen.push(JSON.parse(String(init.body)));
          return geminiSse([geminiFrame([{ text: 'ok' }])]);
        }) as unknown as typeof fetch;
        return p;
      };
      await drainStream(mk({ GEMINI_THINKING_LEVEL: 'low', GEMINI_MAX_TOKENS: '512' }), BASE_INPUT);
      expect(seen[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
      expect(seen[0].generationConfig.maxOutputTokens).toBe(512);
      await drainStream(mk({ GEMINI_THINKING_LEVEL: 'ultra' }), BASE_INPUT);
      expect(seen[1].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    } finally {
      restore();
    }
  });
});

describe('Gemini provider selection and telemetry', () => {
  it('BHASYA_PROVIDER selects gemini; default and openrouter paths are unchanged', () => {
    // Hermetic: fromEnv falls through to process.env by design, so scrub the
    // shell to prove the default contract deterministically.
    const restore = scrubProviderEnv();
    try {
      expect(ModelRouter.fromEnv({}).adapterId).toBe('dev-grounded-1');
      const open = ModelRouter.fromEnv({ BHASYA_MODEL_API_KEY: 'k', BHASYA_MODEL_ID: 'm' });
      expect((open as any).adapter).toBeInstanceOf(HttpProviderAdapter);
      const explicit = ModelRouter.fromEnv({ BHASYA_PROVIDER: 'openrouter', BHASYA_MODEL_API_KEY: 'k', BHASYA_MODEL_ID: 'm' });
      expect((explicit as any).adapter).toBeInstanceOf(HttpProviderAdapter);
      const gemini = ModelRouter.fromEnv({ BHASYA_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
      expect((gemini as any).adapter).toBeInstanceOf(GoogleGeminiProvider);
      expect(gemini.adapterId).toBe('gemini-3.1-flash-lite');
      // Missing Gemini key falls back exactly like a missing OpenRouter key.
      expect(ModelRouter.fromEnv({ BHASYA_PROVIDER: 'gemini' }).adapterId).toBe('dev-grounded-1');
      expect((ModelRouter.fromEnv({ BHASYA_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }) as any).adapter)
        .toBeInstanceOf(GoogleGeminiProvider);
    } finally {
      restore();
    }
  });

  it('service telemetry records provider google with TTFT and sizes, no content', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const { provider } = recordingGemini('Direct answer.');
      svc.router = new ModelRouter(provider);
      const events: StreamItem[] = [];
      const result = await streamExplainSelection(svc, identity, { anchorId: anchor.anchorId }, async (ev) => {
        if (ev.type === 'chunk') events.push({ kind: 'chunk', text: (ev as any).text });
      });
      expect(result.text).toBe('Direct answer.');
      expect(result.modelId).toBe('gemini-3.1-flash-lite');
      const rows = (await svc.db.query(
        `SELECT metadata FROM event_log WHERE resource_id = $1 AND event_type = 'thread_created'`, [result.threadId],
      )).rows as any[];
      const meta = rows[0].metadata as Record<string, unknown>;
      expect(meta.modelId).toBe('gemini-3.1-flash-lite');
      expect(meta.provider).toBe('google');
      expect(typeof meta.ttftMs).toBe('number');
      expect(typeof meta.totalMs).toBe('number');
      expect(typeof meta.inputTokenEstimate).toBe('number');
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain(selA);
      expect(serialized).not.toContain('Direct answer.');
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
