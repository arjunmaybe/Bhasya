import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DevGroundedAdapter, HttpProviderAdapter, ModelRouter,
  estimateExplainInputSize, extractDelta, parseSseBuffer,
} from '@bhasya/ai';
import type { ExplainInput, ExplainOutput, ProviderAdapter, StreamItem } from '@bhasya/ai';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor, streamExplainSelection } from '../apps/api/src/services.js';
import { setServices } from '../apps/api/src/services.js';
import { createApp } from '../apps/api/src/app.js';

/** Build an SSE Response, optionally fragmented mid-frame like a network. */
function sseResponse(frames: string[], opts: { status?: number; splitEvery?: number } = {}): Response {
  const raw = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(raw);
  const every = opts.splitEvery ?? Math.max(1, Math.floor(bytes.length / 3));
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

const deltaFrame = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ choices: [{ delta: { content: text } }], ...extra });

async function collectStream(
  svc: { router: ModelRouter }, identity: { userId: string; workspaceId: string; email: string },
  args: { anchorId: string; question?: string; threadId?: string },
): Promise<{ events: Array<{ type: string; text?: string; result?: any; telemetry?: any }>; result: any }> {
  const events: any[] = [];
  const result = await streamExplainSelection(svc as any, identity, args, async (ev) => {
    events.push(ev.type === 'chunk' ? { type: ev.type, text: (ev as any).text } : ev);
  });
  return { events, result };
}

describe('SSE parsing (pure, no network)', () => {
  it('reassembles frames split across network chunks', () => {
    const full = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    const cut = Math.floor(full.length / 2);
    const first = parseSseBuffer(full.slice(0, cut));
    expect(first.done).toBe(false);
    const second = parseSseBuffer(first.rest + full.slice(cut));
    expect(second.done).toBe(true);
    const payloads = [...first.payloads, ...second.payloads];
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(second.rest).toBe('');
  });

  it('ignores comments and event lines, keeps data payloads in order', () => {
    const parsed = parseSseBuffer(':ping\n\nevent: message\ndata: {"x":1}\n\ndata: {"y":2}\n\n');
    expect(parsed.done).toBe(false);
    expect(parsed.payloads).toEqual(['{"x":1}', '{"y":2}']);
  });

  it('extractDelta reads delta/message shapes and best-effort metadata; malformed returns null', () => {
    expect(extractDelta(deltaFrame('hi'))?.text).toBe('hi');
    expect(extractDelta(JSON.stringify({ choices: [{ message: { content: 'yo' } }] }))?.text).toBe('yo');
    const meta = extractDelta(deltaFrame('!', {
      model: 'm-1', provider: 'Acme',
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }));
    expect(meta?.model).toBe('m-1');
    expect(meta?.provider).toBe('Acme');
    expect(meta?.promptTokens).toBe(12);
    expect(meta?.completionTokens).toBe(3);
    expect(extractDelta('not json{{{')).toBeNull();
    expect(extractDelta('42')).toBeNull();
    expect(extractDelta(JSON.stringify({ choices: [{ delta: {} }] }))?.text).toBe('');
  });
});

describe('provider streaming', () => {
  it('dev adapter streamed accumulation equals explain() text exactly', async () => {
    const adapter = new DevGroundedAdapter();
    const input: ExplainInput = {
      selection: 'rarest and purest form of generosity',
      nearbyContext: ['Attention is the rarest and purest form of generosity.'],
      userRequest: 'what does this mean in practice?',
      title: 'The Craft of Reading',
      history: [{ role: 'user', content: 'Explain this passage.' }],
    };
    const expected = await adapter.explain(input);
    let acc = '';
    let chunks = 0;
    let done: Extract<StreamItem, { kind: 'done' }> | null = null;
    for await (const item of adapter.streamExplain(input)) {
      if (item.kind === 'chunk') { acc += item.text; chunks += 1; }
      else done = item;
    }
    expect(chunks).toBeGreaterThan(1);
    expect(acc).toBe(expected.text);
    expect(done?.text).toBe(expected.text);
    expect(done?.modelId).toBe('dev-grounded-1');
  });

  it('http adapter accumulates fragmented SSE and sends stream:true', async () => {
    let sentBody = '';
    const fetchFn = (async (_url: unknown, init: any) => {
      sentBody = String(init.body);
      return sseResponse([
        deltaFrame('Hello', { model: 'test-model', provider: 'TestProvider' }),
        'broken{{{',
        deltaFrame(' world'),
        JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      ]);
    }) as unknown as typeof fetch;
    const adapter = new HttpProviderAdapter({ modelId: 'm', endpoint: 'https://x', apiKey: 'k', fetchFn });
    const input: ExplainInput = { selection: 's', nearbyContext: [], userRequest: 'q', title: 't' };
    let acc = '';
    let done: Extract<StreamItem, { kind: 'done' }> | null = null;
    for await (const item of adapter.streamExplain(input)) {
      if (item.kind === 'chunk') acc += item.text;
      else done = item;
    }
    expect(JSON.parse(sentBody).stream).toBe(true);
    expect(acc).toBe('Hello world');
    expect(done?.text).toBe('Hello world');
    expect(done?.modelId).toBe('test-model');
    expect(done?.provider).toBe('TestProvider');
    expect(done?.completionTokens).toBe(4);
  });

  it('http adapter surfaces upstream errors and empty completions cleanly', async () => {
    const failing = new HttpProviderAdapter({
      modelId: 'm', endpoint: 'https://x', apiKey: 'k',
      fetchFn: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch,
    });
    const input: ExplainInput = { selection: 's', nearbyContext: [], userRequest: 'q', title: 't' };
    await expect((async () => {
      for await (const _ of failing.streamExplain(input)) { /* drain */ }
    })()).rejects.toThrow(/provider failed: 502/);
    const empty = new HttpProviderAdapter({
      modelId: 'm', endpoint: 'https://x', apiKey: 'k',
      fetchFn: (async () => sseResponse([])) as unknown as typeof fetch,
    });
    await expect((async () => {
      for await (const _ of empty.streamExplain(input)) { /* drain */ }
    })()).rejects.toThrow(/empty provider response/);
  });

  it('router falls back to a single chunk plus done for explain-only adapters', async () => {
    const explainOnly: ProviderAdapter = {
      id: 'legacy-1',
      explain: async (): Promise<ExplainOutput> => ({ text: 'full answer', modelId: 'legacy-1' }),
    };
    const router = new ModelRouter(explainOnly);
    const items: StreamItem[] = [];
    for await (const item of router.streamExplain({ selection: 's', nearbyContext: [], userRequest: 'q', title: 't' })) {
      items.push(item);
    }
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ kind: 'chunk', text: 'full answer' });
    expect(items[1]).toMatchObject({ kind: 'done', text: 'full answer', modelId: 'legacy-1' });
  });
});

describe('streaming service preserves thread/history/citation semantics', () => {
  it('initial stream persists the exact accumulated text with L0 citation', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const { events, result } = await collectStream(svc, identity, { anchorId: anchor.anchorId });
      const chunks = events.filter((e) => e.type === 'chunk');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((c) => c.text).join('')).toBe(result.text);
      const done = events.find((e) => e.type === 'done');
      expect(done?.result.text).toBe(result.text);
      expect(done?.telemetry.modelId).toBe('dev-grounded-1');
      const row = (await svc.db.query(
        `SELECT content, model_id FROM thread_messages WHERE id = $1`, [result.assistantMessageId],
      )).rows[0] as any;
      expect(String(row.content)).toBe(result.text);
      expect(String(row.model_id)).toBe('dev-grounded-1');
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

  it('follow-up stream preserves thread history and stays in the same thread', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const initial = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
      // Spy through the streaming path: history must still reach the provider.
      const seen: ExplainInput[] = [];
      const recording = new DevGroundedAdapter();
      const orig = recording.streamExplain.bind(recording);
      (recording as any).streamExplain = async function* (input: ExplainInput) {
        seen.push({ ...input, history: [...(input.history ?? [])] });
        yield* orig(input);
      };
      svc.router = new ModelRouter(recording);
      const Q = 'what does this mean in practice?';
      const { events, result } = await collectStream(svc, identity, {
        anchorId: anchor.anchorId, question: Q, threadId: initial.threadId,
      });
      expect(result.threadId).toBe(initial.threadId);
      expect(seen.length).toBe(1);
      expect(seen[0].selection).toBe(selA);
      expect(seen[0].userRequest).toBe(Q);
      expect(seen[0].history?.length).toBe(2);
      const accumulated = events.filter((e) => e.type === 'chunk').map((e) => e.text).join('');
      expect(accumulated).toBe(result.text);
      const msgs = (await svc.db.query(
        `SELECT role, content FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`, [initial.threadId],
      )).rows as any[];
      expect(msgs.length).toBe(4);
      expect(String(msgs[3].content)).toBe(result.text);
    } finally {
      await cleanup();
    }
  });

  it('empty stream throws before persisting any assistant message', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'rarest and purest form of generosity',
      });
      const silent: ProviderAdapter = {
        id: 'silent-1',
        explain: async () => ({ text: '', modelId: 'silent-1' }),
        streamExplain: async function* () {
          yield { kind: 'done', text: '', modelId: 'silent-1' };
        },
      };
      svc.router = new ModelRouter(silent);
      await expect(collectStream(svc, identity, { anchorId: anchor.anchorId })).rejects.toThrow(/empty provider response/);
      const rows = (await svc.db.query(
        `SELECT role FROM thread_messages WHERE thread_id = ANY(SELECT id FROM threads WHERE anchor_id = $1)`,
        [anchor.anchorId],
      )).rows as any[];
      expect(rows.every((r) => r.role !== 'assistant')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('mid-stream interruption throws and persists no partial answer', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'rarest and purest form of generosity',
      });
      const flaky: ProviderAdapter = {
        id: 'flaky-1',
        explain: async () => ({ text: 'unreached', modelId: 'flaky-1' }),
        streamExplain: async function* () {
          yield { kind: 'chunk', text: 'partial-' };
          throw new Error('upstream reset');
        },
      };
      svc.router = new ModelRouter(flaky);
      const seen: string[] = [];
      await expect(streamExplainSelection(svc, identity, { anchorId: anchor.anchorId }, async (ev) => {
        if (ev.type === 'chunk') seen.push(ev.text);
      })).rejects.toThrow(/upstream reset/);
      expect(seen.join('')).toBe('partial-');
      const rows = (await svc.db.query(
        `SELECT content FROM thread_messages WHERE thread_id = ANY(SELECT id FROM threads WHERE anchor_id = $1) AND role = 'assistant'`,
        [anchor.anchorId],
      )).rows as any[];
      expect(rows.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('latency/size metadata is recorded without any content', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const Q = 'what does this mean in practice?';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const initial = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
      await collectStream(svc, identity, { anchorId: anchor.anchorId, question: Q, threadId: initial.threadId });
      const rows = (await svc.db.query(
        `SELECT metadata FROM event_log WHERE resource_id = $1 AND event_type = 'thread_message_sent' ORDER BY created_at DESC LIMIT 1`,
        [initial.threadId],
      )).rows as any[];
      const meta = rows[0].metadata as Record<string, unknown>;
      for (const k of ['ttftMs', 'generationMs', 'totalMs', 'modelId', 'inputChars', 'inputTokenEstimate', 'outputChars', 'outputTokenEstimate', 'durationMs']) {
        expect(typeof meta[k], k).toBe(k === 'modelId' ? 'string' : 'number');
      }
      expect(Number(meta.ttftMs)).toBeGreaterThanOrEqual(0);
      expect(Number(meta.totalMs)).toBeGreaterThanOrEqual(Number(meta.ttftMs));
      for (const forbidden of ['prompt', 'response', 'content', 'selection', 'text', 'email', 'ip']) {
        expect(meta).not.toHaveProperty(forbidden);
      }
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain(selA);
      expect(serialized).not.toContain(Q);
    } finally {
      await cleanup();
    }
  });
});

describe('streaming API routes (SSE)', () => {
  async function readSse(res: Response): Promise<{ events: Array<{ event: string; data: any }> }> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events: Array<{ event: string; data: any }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        let event = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) events.push({ event, data: JSON.parse(line.slice(5)) });
        }
      }
    }
    return { events };
  }

  it('explain/stream emits chunks then done, and persists the thread', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'rarest and purest form of generosity',
      });
      const res = await app.request('/api/threads/explain/stream', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchorId: anchor.anchorId }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const { events } = await readSse(res);
      const chunks = events.filter((e) => e.event === 'chunk');
      const dones = events.filter((e) => e.event === 'done');
      expect(events.some((e) => e.event === 'error')).toBe(false);
      expect(chunks.length).toBeGreaterThan(0);
      expect(dones.length).toBe(1);
      expect(chunks.map((c) => c.data.text).join('')).toBe(dones[0].data.text);
      expect(dones[0].data.telemetry.modelId).toBe('dev-grounded-1');
      expect(typeof dones[0].data.telemetry.ttftMs).toBe('number');
      const thread = await app.request(`/api/threads/${dones[0].data.threadId}`);
      const tj = (await thread.json()) as any;
      expect(tj.messages.length).toBe(2);
      expect(String(tj.messages[1].content)).toBe(dones[0].data.text);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('messages/stream keeps follow-ups in the same thread with history', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const call = async (path: string, init?: RequestInit) =>
        app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'Readers who annotate remember more',
      });
      const first = await call('/api/threads/explain', { method: 'POST', body: JSON.stringify({ anchorId: anchor.anchorId }) });
      const firstJson = (await first.json()) as any;
      const Q = 'why does skimming fail here?';
      const res = await call(`/api/threads/${firstJson.threadId}/messages/stream`, {
        method: 'POST', body: JSON.stringify({ content: Q }),
      });
      expect(res.status).toBe(200);
      const { events } = await readSse(res);
      const dones = events.filter((e) => e.event === 'done');
      expect(dones.length).toBe(1);
      expect(dones[0].data.threadId).toBe(firstJson.threadId);
      expect(String(dones[0].data.text)).toContain(Q);
      const tj = (await (await call(`/api/threads/${firstJson.threadId}`)).json()) as any;
      expect(tj.messages.length).toBe(4);
      expect(String(tj.messages[2].content)).toBe(Q);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('stream routes reject invalid bodies without opening a stream', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      // 400 (not 404) proves each stream route is registered on the router:
      // validation runs before any thread lookup or provider call.
      const bad = await app.request('/api/threads/explain/stream', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-type')).toContain('application/json');
      const badFollowup = await app.request('/api/threads/00000000-0000-0000-0000-000000000000/messages/stream', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(badFollowup.status).toBe(400);
      expect(badFollowup.headers.get('content-type')).toContain('application/json');
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});

describe('provider input size (context reporting; history is preserved)', () => {
  it('measures initial vs follow-up input and keeps full grounding', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: ing.versionId, selectedText: selA });
      const seen: ExplainInput[] = [];
      const recording = new DevGroundedAdapter();
      const orig = recording.streamExplain.bind(recording);
      (recording as any).streamExplain = async function* (input: ExplainInput) {
        seen.push({ ...input, history: [...(input.history ?? [])] });
        yield* orig(input);
      };
      svc.router = new ModelRouter(recording);
      await collectStream(svc, identity, { anchorId: anchor.anchorId });
      const Q = 'what does this mean in practice?';
      await collectStream(svc, identity, {
        anchorId: anchor.anchorId, question: Q, threadId: (await svc.db.query(
          `SELECT id FROM threads WHERE anchor_id = $1`, [anchor.anchorId],
        )).rows[0].id as string,
      });
      const sizes = seen.map((input) => ({ ...estimateExplainInputSize(input), historyTurns: (input.history ?? []).length }));
      // Redundant-by-design grounding is kept: exact selection + full L0 passage.
      expect(seen[0].nearbyContext[0]).toContain(selA);
      expect(seen[1].history?.length).toBe(2);
      expect(sizes[1].inputChars).toBeGreaterThan(sizes[0].inputChars);
      console.log(`input-size initial=${sizes[0].inputChars}chars ~${sizes[0].inputTokenEstimate}tok, follow-up=${sizes[1].inputChars}chars ~${sizes[1].inputTokenEstimate}tok`);
    } finally {
      await cleanup();
    }
  });

  it('estimateExplainInputSize sums all parts at ~4 chars per token', () => {
    const size = estimateExplainInputSize({
      selection: 'abcd', nearbyContext: ['ef'], userRequest: 'gh', title: 'ij', history: [{ role: 'user', content: 'kl' }],
    });
    expect(size.inputChars).toBe(12);
    expect(size.inputTokenEstimate).toBe(3);
  });
});

describe('streaming latency telemetry (local measurement)', () => {
  it('records TTFT/generation/total around a delayed first chunk', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'rarest and purest form of generosity',
      });
    const delayed: ProviderAdapter = {
        id: 'delayed-1',
        explain: async () => ({ text: 'slow answer', modelId: 'delayed-1' }),
        streamExplain: async function* () {
          await new Promise((r) => setTimeout(r, 80));
          yield { kind: 'chunk', text: 'slow ' };
          yield { kind: 'chunk', text: 'answer' };
          yield { kind: 'done', text: 'slow answer', modelId: 'delayed-1', provider: 'LocalLab' };
        },
      };
      svc.router = new ModelRouter(delayed);
      const { events } = await collectStream(svc, identity, { anchorId: anchor.anchorId });
      const done = events.find((e) => e.type === 'done');
      const t = done?.telemetry;
      expect(t.modelId).toBe('delayed-1');
      expect(t.provider).toBe('LocalLab');
      expect(t.ttftMs).toBeGreaterThanOrEqual(50);
      expect(t.generationMs).toBeGreaterThanOrEqual(0);
      expect(t.totalMs).toBeGreaterThanOrEqual(t.ttftMs);
      expect(t.inputChars).toBeGreaterThan(0);
      console.log(`latency ttftMs=${Math.round(t.ttftMs)} generationMs=${Math.round(t.generationMs)} totalMs=${Math.round(t.totalMs)} model=${t.modelId} provider=${t.provider} inputChars=${t.inputChars} inputTok~${t.inputTokenEstimate}`);
    } finally {
      await cleanup();
    }
  });
});

describe('Reader streaming UI (static contract)', () => {
  const src = () =>
    readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');

  it('consumes SSE with reader/decoder, handles chunk/done/error, no timers', () => {
    const s = src();
    expect(s).toMatch(/consumeThreadStream/);
    expect(s).toMatch(/getReader\(\)/);
    expect(s).toMatch(/TextDecoder/);
    expect(s).toMatch(/event === 'done'/);
    expect(s).toMatch(/event === 'error'/);
    expect(s).toMatch(/stream ended without result/);
  });

  it('shows partial assistant text progressively without per-chunk scrolling', () => {
    const s = src();
    expect(s).toMatch(/streamText/);
    expect(s).toMatch(/data-streaming="true"/);
    // Chunk handlers only accumulate text; navigation stays one-shot.
    const chunkIdx = s.indexOf('receivedAny = true');
    expect(chunkIdx).toBeGreaterThanOrEqual(0);
    const window = s.slice(chunkIdx, chunkIdx + 400);
    expect(window).not.toMatch(/scrollTop/);
    expect(window).not.toMatch(/scrollIntoView/);
    expect(s).toMatch(/pendingQuestionRef\.current = tempId/);
  });

  it('keeps exact-question nav, panel modes, latest marker; falls back cleanly', () => {
    const s = src();
    expect(s).toMatch(/pendingQuestionRef/);
    expect(s).toMatch(/setPanelMode\('expanded'\)/);
    expect(s).toMatch(/data-panel=\{panelMode\}/);
    expect(s).toMatch(/msg-user-latest/);
    expect(s).toMatch(/\/messages\/stream/);
    expect(s).toMatch(/\/explain\/stream/);
    expect(s).toMatch(/\/api\/threads\/explain/);
    expect(s).toMatch(/\/api\/threads\/\$\{threadId\}\/messages/);
    expect(s).toMatch(/streamAbortRef/);
  });
});
