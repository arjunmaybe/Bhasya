import { describe, expect, it } from 'vitest';
import { DevGroundedAdapter, GoogleGeminiProvider, ModelRouter, buildGroundedUserText } from '@bhasya/ai';
import type { ChatTurn, ExplainInput, ExplainOutput, ProviderAdapter } from '@bhasya/ai';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';

/**
 * Task-format regression: the user's request is an operation ON the passage,
 * never subject matter. For the same selected passage, different requests
 * must produce observably different, directly-answering outputs — never
 * meta-language discussing the request itself.
 *
 * Deterministic: DevGroundedAdapter renders task formats extractively from
 * passage wording (real semantic quality comes from providers; the contract
 * — direct answer, exact format, grounded, no meta-talk — is enforced here).
 */

const SEL =
  'Attention is the rarest and purest form of generosity. To attend fully to a passage is to give it time.';
const CTX = [
  'Attention is the rarest and purest form of generosity. To attend fully to a passage is to give it time.',
  'Distraction, by contrast, fractures the mind into small tradable pieces.',
];

const inputFor = (userRequest: string, history: ChatTurn[] = []): ExplainInput => ({
  selection: SEL,
  nearbyContext: [...CTX],
  userRequest,
  title: 'The Craft of Reading',
  history,
});

/** Meta-language and scaffolding about the request itself — banned in every output. */
const META_PHRASES = [
  'you asked',
  'considering',
  'relevant point',
  'answering that from the passage',
  'your request',
  'the request',
  'this passage says:',
  'why it matters:',
  'in context, the surrounding text',
  'read the selection together',
  'read it in place',
];

function expectNoMeta(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of META_PHRASES) {
    expect(lower, `meta-language: "${phrase}"`).not.toContain(phrase);
  }
}

const countPoints = (text: string): number =>
  text.split('\n').filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length;

const countSentences = (text: string): number =>
  (text.match(/[^.!?]+[.!?]/g) ?? []).length;

/** Bodies of numbered points (without their `N.` prefixes). */
const pointBodies = (text: string): string[] =>
  text.split('\n').filter((l) => /^\s*\d+[.)]\s+\S/.test(l))
    .map((l) => String(l.match(/^(\s*\d+[.)]\s+)(.*)$/)?.[2] ?? l).trim());

/** Fragment endings: a point/sentence ending with one of these is cut mid-phrase. */
const DANGLING_TAIL = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'yet', 'so', 'nor',
  'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'as',
  'that', 'which', 'who', 'what', 'when', 'where', 'if',
  'is', 'are', 'was', 'were', 'be', 'getting',
  'up', 'out', 'off', 'down', 'away', 'back',
]);

/** Finite auxiliaries: an infinitive-led point must still contain one (real clause). */
const FINITE_AUX = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
  'will', 'would', 'should', 'could', 'can', 'may', 'might', 'must',
  'do', 'does', 'did',
]);

function lastWord(s: string): string {
  const w = s.replace(/[.]+$/, '').trim().split(/\s+/).filter(Boolean);
  return (w[w.length - 1] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function wordSetOf(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 4));
}

function jaccardText(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Exact count + every point a complete statement (no fragments, no placeholders counted). */
function expectCoherentNumbered(text: string, n: number, minWords = 3): void {
  const bodies = pointBodies(text);
  expect(bodies.length).toBe(n);
  for (const b of bodies) {
    if (b === '—' || b === '—.') continue; // honest gap marker for degenerate selections
    const words = b.split(/\s+/).filter(Boolean);
    expect(words.length, `point too short: "${b}"`).toBeGreaterThanOrEqual(minWords);
    expect(/[.?!…]$/.test(b), `point must end with terminal punctuation: "${b}"`).toBe(true);
    expect(DANGLING_TAIL.has(lastWord(b)), `dangling ending: "${b}"`).toBe(false);
  }
}

/** Every content word (len>4) of each point must come from the selection. */
function expectGroundedInSel(text: string, sel: string): void {
  const vocab = wordSetOf(sel);
  for (const b of pointBodies(text)) {
    for (const w of b.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 4)) {
      expect(vocab.has(w), `ungrounded word "${w}" in: "${b}"`).toBe(true);
    }
  }
}

/** No exact, near-duplicate, or parent/child-contained points (markers excluded). */
function expectDistinctPoints(text: string, maxOverlap = 0.7): void {
  const bodies = pointBodies(text).filter((b) => b !== '—' && b !== '—.');
  const toks = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      expect(jaccardText(bodies[i], bodies[j]), `near-duplicate points ${i + 1}/${j + 1}`).toBeLessThan(maxOverlap);
      // Containment either way: a point whose every word already appears in
      // another point adds no proposition (parent/child duplication).
      const a = toks(bodies[i]);
      const b = toks(bodies[j]);
      const smaller = a.size <= b.size ? a : b;
      const larger = a.size <= b.size ? b : a;
      let inter = 0;
      for (const w of smaller) if (larger.has(w)) inter += 1;
      expect(
        smaller.size > 0 && inter === smaller.size,
        `contained points ${i + 1}/${j + 1}: "${bodies[i]}" vs "${bodies[j]}"`,
      ).toBe(false);
    }
  }
}

/**
 * Grammatical point shapes: no point may START with stacked prepositions
 * ("With as a newbie…" — a stranded split seam; mid-clause phrasal verbs
 * like "come up with as…" are verbatim source wording and stay allowed),
 * and no bare infinitive-led fragments ("To get macOS…" without a finite
 * clause). Infinitive-led full sentences ("To attend… is…") remain allowed.
 */
function expectGrammaticalPoints(text: string): void {
  for (const b of pointBodies(text)) {
    if (b === '—' || b === '—.') continue;
    expect(
      b,
      `stranded preposition stack at point start: "${b}"`,
    ).not.toMatch(/^(with|for|from|of|to|in|on|at|about|as)\s+(as|of|to|with|from|that)\b/i);
    if (/^to\s+/i.test(b)) {
      const hasFinite = b.toLowerCase().split(/[^a-z0-9]+/).some((w) => FINITE_AUX.has(w));
      expect(hasFinite, `bare infinitive fragment: "${b}"`).toBe(true);
    }
  }
}

/** Two phrases must appear in the SAME point (dependent clause kept with its matrix). */
function expectSamePoint(text: string, a: string, b: string): void {
  const bodies = pointBodies(text);
  const hit = bodies.some(
    (p) => p.toLowerCase().includes(a.toLowerCase()) && p.toLowerCase().includes(b.toLowerCase()),
  );
  expect(hit, `expected "${a}" and "${b}" in the same point:\n${text}`).toBe(true);
}

/** No stacked/duplicated terminal punctuation anywhere ("?.", "!.", ".."). */
function expectCleanTerminals(text: string): void {
  expect(text, 'stacked terminal punctuation').not.toMatch(/[?!]\./);
  expect(text, 'doubled periods').not.toMatch(/\.\./);
  for (const b of pointBodies(text)) {
    if (b === '—' || b === '—.') continue;
    expect(b, `point lacks terminal mark: "${b}"`).toMatch(/[.?!…]$/);
  }
}

/** Every point's parentheses must balance (truncation must not strand "("). */
function expectBalancedParens(text: string): void {
  for (const b of pointBodies(text)) {
    if (b === '—' || b === '—.') continue;
    const open = (b.match(/\(/g) ?? []).length;
    const close = (b.match(/\)/g) ?? []).length;
    expect(open, `unmatched "(" in: "${b}"`).toBe(close);
  }
}

describe('task requests answer directly about the passage', () => {
  it('default explanation directly explains the passage, with no scaffolding', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('Explain this passage.'));
    // Substantive and grounded: selection plus context, as a clean paragraph.
    expect(text.length).toBeGreaterThan(200);
    expect(text).toContain('rarest and purest form of generosity');
    expect(text).toContain('Distraction, by contrast');
    expectNoMeta(text);
  });

  it('"in 3 points" produces exactly 3 grounded points', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('explain this to me in 3 points'));
    expectCoherentNumbered(text, 3);
    expectGroundedInSel(text, SEL);
    expectDistinctPoints(text);
    expect(text).toContain('generosity');
    // Task modes use the selection only: nearby-context wording stays out.
    expect(text).not.toContain('Distraction');
    expectNoMeta(text);
    // Observably different from the generic explanation.
    const generic = (await adapter.explain(inputFor('Explain this passage.'))).text;
    expect(text).not.toBe(generic);
  });

  it.each([
    ['explain this in three points', 3],
    ['explain this in 5 points', 5],
    ['explain this in five points', 5],
    ['give me 3 bullets', 3],
    ['give me the main points', 3],
  ])('"%s" produces the exact point count', async (req, want) => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor(req as string));
    expectCoherentNumbered(text, want as number);
    expectGroundedInSel(text, SEL);
    expectDistinctPoints(text);
    expect(text).toContain('generosity');
    expect(text).not.toContain('Distraction');
    expectNoMeta(text);
  });

  it('"like a school student" simplifies language while preserving meaning', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('explain this like to a school student'));
    const generic = (await adapter.explain(inputFor('Explain this passage.'))).text;
    expect(text).not.toBe(generic);
    // Same key terms, plainer shape: every sentence is short and direct.
    expect(text).toContain('generosity');
    const maxWords = Math.max(
      ...(text.match(/[^.!?]+[.!?]/g) ?? []).map((s) => s.split(/\s+/).filter(Boolean).length),
    );
    expect(maxWords).toBeLessThanOrEqual(12);
    expectNoMeta(text);
  });

  it('"in 5 sentences" produces exactly 5 substantive sentences', async () => {
    // A 5-sentence answer needs a selection that supports five real
    // sentences: the short two-sentence SEL cannot supply them without
    // fragments or gap markers (see the degenerate-selection contract).
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(richInputFor('explain this in 5 sentences'));
    expect(countSentences(text)).toBe(5);
    expect(text).toContain('generosity');
    expectNoPoison(text);
    const vocab = wordSetOf(RICH_SEL);
    for (const s of text.match(/[^.!?]+[.!?]/g) ?? []) {
      expect(s.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
      expect(DANGLING_TAIL.has(lastWord(s)), `dangling ending: "${s}"`).toBe(false);
      for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 4)) {
        expect(vocab.has(w), `ungrounded word "${w}"`).toBe(true);
      }
    }
    expectNoMeta(text);
  });

  it.each([
    ['explain this in 3 sentences', 3],
    ['explain this in three sentences', 3],
  ])('"%s" produces the exact sentence count', async (req, want) => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor(req as string));
    expect(countSentences(text)).toBe(want);
    expect(text).toContain('generosity');
    expect(text).not.toContain('Distraction');
    for (const s of text.match(/[^.!?]+[.!?]/g) ?? []) {
      expect(s.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
      expect(DANGLING_TAIL.has(lastWord(s)), `dangling ending: "${s}"`).toBe(false);
    }
    expectNoMeta(text);
  });

  it('"explain this in five sentences" produces the exact sentence count', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(richInputFor('explain this in five sentences'));
    expect(countSentences(text)).toBe(5);
    expect(text).toContain('generosity');
    expectNoPoison(text);
    for (const s of text.match(/[^.!?]+[.!?]/g) ?? []) {
      expect(s.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
      expect(DANGLING_TAIL.has(lastWord(s)), `dangling ending: "${s}"`).toBe(false);
    }
    expectNoMeta(text);
  });

  it.each(['simplify this', 'explain more simply'])('"%s" uses simplify mode', async (req) => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor(req as string));
    expect(text).toContain('generosity');
    const maxWords = Math.max(
      ...(text.match(/[^.!?]+[.!?]/g) ?? []).map((s) => s.split(/\s+/).filter(Boolean).length),
    );
    expect(maxWords).toBeLessThanOrEqual(12);
    expectNoMeta(text);
  });

  it('"summarize this" uses summary mode', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('summarize this'));
    expect(text.startsWith('In brief:')).toBe(true);
    expect(text).toContain('rarest and purest form of generosity');
    expectNoMeta(text);
  });

  it('does not trigger simplify from "plain" inside unrelated words', async () => {
    const adapter = new DevGroundedAdapter();
    // "please explain this" contains "plain" inside "explain" — it must be
    // treated as a direct question, not a simplify request. Direct answers
    // come from the selection alone with no boilerplate scaffolding.
    const { text } = await adapter.explain(inputFor('please explain this'));
    expect(text).not.toContain('That is what the passage states in its own terms.');
    expect(text).toContain('rarest and purest form of generosity');
    expectNoMeta(text);
  });

  it('a specific question gets a direct grounded answer, not the request echoed', async () => {
    const adapter = new DevGroundedAdapter();
    const Q = 'Can you give me a concrete example?';
    const { text } = await adapter.explain(inputFor(Q));
    expect(text).toContain('rarest and purest form of generosity');
    expect(text).not.toContain(Q);
    expectNoMeta(text);
  });
});

describe('provider input separates content from task (actual constructed input)', () => {
  it('grounded user text puts the request exactly once under TASK, never in CONTENT', () => {
    const text = buildGroundedUserText(inputFor('explain this in 5 sentences'));
    expect(text).toContain('CONTENT');
    expect(text).toContain('TASK');
    expect(text).toContain('rarest and purest form of generosity');
    // The request appears exactly once — under TASK.
    expect(text.split('explain this in 5 sentences').length - 1).toBe(1);
    expect(text.indexOf('TASK')).toBeLessThan(text.indexOf('explain this in 5 sentences'));
    expect(text).toContain('exactly N points or exactly N sentences');
  });

  it('real provider bodies carry the task contract (Gemini request body)', async () => {
    const bodies: any[] = [];
    const fetchFn = (async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new GoogleGeminiProvider({ apiKey: 'k', fetchFn });
    await provider.explain(inputFor('explain this in 3 points'));
    const body = bodies[0];
    const system = String(body.systemInstruction.parts[0].text);
    expect(system).toContain('never subject matter');
    const last = String(body.contents[body.contents.length - 1].parts[0].text);
    expect(last).toContain('TASK');
    expect(last).toContain('explain this in 3 points');
    expect(last.split('explain this in 3 points').length - 1).toBe(1);
  });
});

describe('follow-up answers the new question directly in the same thread', () => {
  it('task follow-up persists a direct grounded answer; thread/history unchanged', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selA,
      });

      const initial = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
      const T0 = String(initial.text);
      expect(T0).toContain(selA);

      const Q = 'explain this to me in 3 points';
      const follow = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: Q, threadId: initial.threadId,
      });
      const T1 = String(follow.text);

      // Same thread, new direct answer in the requested format.
      expect(follow.threadId).toBe(initial.threadId);
      expect(T1).not.toBe(T0);
      expect(countPoints(T1)).toBe(3);
      // Selection-only task rendering subdivides the short slice instead of
      // quoting it whole (nearby L0/L1 wording never fills points), so the
      // slice's content words are covered across points rather than verbatim.
      for (const w of ['rarest', 'purest', 'generosity']) {
        expect(T1.toLowerCase(), `missing selection word "${w}"`).toContain(w);
      }
      // The request wording is the operation, never quoted content.
      expect(T1).not.toContain(Q);
      expectNoMeta(T1);

      // Thread/history persistence semantics unchanged: 4 messages in order.
      const msgs = (await svc.db.query(
        `SELECT role, content FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`,
        [initial.threadId],
      )).rows as any[];
      expect(msgs.length).toBe(4);
      expect(msgs[0].role).toBe('user');
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[2].role).toBe('user');
      expect(String(msgs[2].content)).toBe(Q);
      expect(msgs[3].role).toBe('assistant');
      expect(String(msgs[3].content)).toBe(T1);

      // Citation/evidence still resolve to the same passage (L0).
      const l0 = (await svc.db.query(
        `SELECT e.passage_id FROM citations c
           JOIN evidence e ON e.id = c.evidence_id
           JOIN thread_messages m ON m.id = e.thread_message_id
          WHERE m.id = $1 AND e.scope_level = 'L0'`,
        [follow.assistantMessageId],
      )).rows as any[];
      expect(l0.length).toBeGreaterThanOrEqual(1);
      expect(String(l0[0].passage_id)).toBe(anchor.passageId);
    } finally {
      await cleanup();
    }
  });
});

/**
 * Long-context fixtures: prove points stay concise and never redistribute
 * the whole pool. The marker sentence shares no content terms with the
 * selection, so salience ranking must leave it out of small-N answers.
 */
const LONG_SEL =
  'Memory keeps what attention touches and readers remember annotated passages.';
const LONG_CTX = [
  'Memory keeps what attention touches and readers remember annotated passages. Attention guides readers toward passages that reward careful reading and steady focus.',
  'Readers who annotate remember more because annotated passages hold attention longer. Memory favors readers who return to annotated passages with steady attention and care.',
  'Zebra nebulae dance while quiet rivers hum beyond the old stone bridge. Distraction fractures attention while readers skim annotated passages without remembering them.',
];

const longInputFor = (userRequest: string, history: ChatTurn[] = []): ExplainInput => ({
  selection: LONG_SEL,
  nearbyContext: [...LONG_CTX],
  userRequest,
  title: 'The Craft of Reading',
  history,
});

describe('points stay concise on long context (no article dump)', () => {
  it('"5 points" keeps exact count with each point capped', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(longInputFor('explain this in 5 points'));
    expect(countPoints(text)).toBe(5);
    for (const line of text.split('\n').filter((l) => /^\s*\d+[.)]\s+\S/.test(l))) {
      expect(line.length).toBeLessThanOrEqual(280);
    }
    // Bounded output, not the whole multi-hundred-word pool redistributed.
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain('attention');
    expectNoMeta(text);
  });

  it('unrelated sections rank out of small-N answers', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(longInputFor('explain this in 2 points'));
    expectCoherentNumbered(text, 2);
    expectGroundedInSel(text, LONG_SEL);
    expectDistinctPoints(text);
    expect(text).not.toContain('Zebra');
    expect(text).not.toContain('nebulae');
    expect(text).toContain('attention');
    expectNoMeta(text);
  });

  it('"give me the key points" without a number defaults to 3 concise points', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('give me the key points'));
    expectCoherentNumbered(text, 3);
    expectGroundedInSel(text, SEL);
    expectDistinctPoints(text);
    expect(text).toContain('generosity');
    expect(text).not.toContain('Distraction');
    expectNoMeta(text);
  });
});

describe('shorten operates on the previous answer, never the article', () => {
  const POINTS_PREV = [
    '1. Attention is the rarest and purest form of generosity in this passage about reading books slowly every single day.',
    '2. To attend fully to a passage is to give it time and steady focus without rushing ahead too quickly today.',
    '3. Distraction fractures the mind into small tradable pieces instead of letting readers settle into deep and quiet focus.',
    '4. Memory keeps what attention touches over time with care and patience across many slow and deliberate rereadings.',
    '5. Readers who annotate remember more than readers who skim quickly through pages without ever pausing to think.',
  ].join('\n');

  const historyFor = (prev: string): ChatTurn[] => [
    { role: 'user', content: 'Explain this passage.' },
    { role: 'assistant', content: 'Prior direct explanation.' },
    { role: 'user', content: 'explain this in 5 points' },
    { role: 'assistant', content: prev },
  ];

  it('"shorten these points" compresses the previous points, keeping count', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('shorten these points', historyFor(POINTS_PREV)));
    expectCoherentNumbered(text, 5);
    expect(text.length).toBeLessThan(POINTS_PREV.length);
    expect(text).toContain('generosity');
    expect(text).not.toContain('shorten these points');
    // Each shortened point keeps its original proposition: strong word
    // overlap, leading subject area retained, no new content words.
    const orig = pointBodies(POINTS_PREV);
    pointBodies(text).forEach((b, i) => {
      const oWords = orig[i].split(/\s+/).filter(Boolean);
      const bWords = b.split(/\s+/).filter(Boolean);
      expect(bWords.length).toBeLessThan(oWords.length);
      const oSet = new Set(oWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      const bSet = new Set(bWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      let inter = 0;
      for (const w of bSet) if (oSet.has(w)) inter += 1;
      expect(inter / oSet.size, `weak retention in point ${i + 1}`).toBeGreaterThan(0.25);
      for (const w of [...bSet].filter((x) => x.length > 4)) {
        expect(oSet.has(w), `new word "${w}"`).toBe(true);
      }
    });
    expectNoMeta(text);
  });

  it('"make it shorter" halves a prose answer while staying grounded', async () => {
    const adapter = new DevGroundedAdapter();
    const prev = 'Alpha readers keep steady attention. Beta readers annotate every passage. Gamma memory holds annotated ideas. Delta skimming loses the thread.';
    const { text } = await adapter.explain(inputFor('make it shorter', historyFor(prev)));
    expect(text.length).toBeLessThan(prev.length);
    expect(text).toContain('Alpha readers');
    expect(text).not.toContain('Delta skimming');
    expectNoMeta(text);
  });

  it('shorten with no previous answer falls back to a bounded passage summary', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('shorten this'));
    expect(text.startsWith('In brief:')).toBe(true);
    expect(text).toContain('rarest and purest form of generosity');
    expectNoMeta(text);
  });

  it('service-level points -> shorten chain shortens without dumping the article', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      // A full-passage selection: task points subdivide compressible content,
      // so shortening can preserve the count while staying strictly shorter.
      // (A few-word slice cannot yield 5 distinct complete statements from
      // selection wording alone, by construction.)
      const selFull =
        'Attention is the rarest and purest form of generosity. ' +
        'To attend fully to a passage is to give it time.';
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selFull,
      });
      const initial = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
      const points = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: 'explain this in 5 points', threadId: initial.threadId,
      });
      const short = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: 'shorten these points', threadId: initial.threadId,
      });
      const pointsText = String(points.text);
      const shortText = String(short.text);
      expectCoherentNumbered(pointsText, 5);
      expectCoherentNumbered(shortText, 5);
      // Compression preserves the count and stays strictly shorter.
      expect(shortText.length).toBeLessThan(pointsText.length);
      expect(shortText).toContain('generosity');
      expect(shortText).not.toContain('shorten these points');
      expectNoMeta(shortText);
      // Same thread retained; persistence order intact (6 messages).
      expect(short.threadId).toBe(initial.threadId);
      const msgs = (await svc.db.query(
        `SELECT role FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`,
        [initial.threadId],
      )).rows as any[];
      expect(msgs.map((m) => String(m.role))).toEqual(
        ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
      );
    } finally {
      await cleanup();
    }
  });
});

describe('simplify follow-ups never dump the article', () => {
  it('simplify on long context stays bounded by the selection', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(longInputFor('explain more simply'));
    expect(text).toContain('attention');
    expect(text).not.toContain('Zebra');
    // Simplify renders the selection only — far shorter than the whole pool.
    expect(text.length).toBeLessThanOrEqual(LONG_SEL.length + 60);
    expectNoMeta(text);
  });
});

/**
 * Poison-context regression: a nearby-context passage sharing generic topic
 * words but carrying distinctive unrelated claims (Asahi / M1-M3 / Gambling)
 * must never leak into selection-scoped task output.
 */
const RICH_SEL =
  'Attention is the rarest and purest form of generosity. ' +
  'To attend fully to a passage is to give it time and steady focus without rushing ahead. ' +
  'Distraction fractures the mind into small tradable pieces while memory keeps what attention touches. ' +
  'Readers who annotate remember more because annotated passages reward careful rereading and steady care.';
const POISON_L1 =
  'Readers gambling on quick ports hoped it would be similar to the M1-M3 Apple Silicon ' +
  'machines and could be quickly supported in Asahi Linux.';

const richInputFor = (userRequest: string, history: ChatTurn[] = []): ExplainInput => ({
  selection: RICH_SEL,
  nearbyContext: [RICH_SEL, POISON_L1],
  userRequest,
  title: 'The Craft of Reading',
  history,
});

const POISON_MARKERS = ['asahi', 'm1', 'gambling'];

function expectNoPoison(text: string): void {
  const lower = text.toLowerCase();
  for (const m of POISON_MARKERS) {
    expect(lower, `leaked nearby-context claim: "${m}"`).not.toContain(m);
  }
}

describe('task modes never leak nearby context (poison L1)', () => {
  it('"explain in 5 points" uses only the selected content', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(richInputFor('explain in 5 points'));
    expectCoherentNumbered(text, 5, 4);
    expectNoPoison(text);
    expectGroundedInSel(text, RICH_SEL);
    expectDistinctPoints(text);
    expectNoMeta(text);
  });

  it('"explain in 5 sentences" uses only the selected content', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(richInputFor('explain this in 5 sentences'));
    expect(countSentences(text)).toBe(5);
    expectNoPoison(text);
    const vocab = wordSetOf(RICH_SEL);
    for (const s of text.match(/[^.!?]+[.!?]/g) ?? []) {
      expect(s.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
      expect(DANGLING_TAIL.has(lastWord(s)), `dangling ending: "${s}"`).toBe(false);
      for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 4)) {
        expect(vocab.has(w), `ungrounded word "${w}"`).toBe(true);
      }
    }
    expectNoMeta(text);
  });

  it('near-duplicate selection sentences do not produce duplicate points', async () => {
    const adapter = new DevGroundedAdapter();
    const sel =
      'Memory keeps what attention touches. Memory keeps what attention touches! ' +
      'Readers who annotate remember more than readers who skim.';
    const { text } = await adapter.explain({
      selection: sel,
      nearbyContext: [sel, POISON_L1],
      userRequest: 'explain in 3 points',
      title: 'The Craft of Reading',
      history: [],
    });
    expectCoherentNumbered(text, 3);
    expectNoPoison(text);
    expectGroundedInSel(text, sel);
    expectDistinctPoints(text);
    expectNoMeta(text);
  });
});

describe('shortening numbered answers preserves each point', () => {
  const FRAG_PREV = [
    '1. Sometimes it would be nice if certain projects getting a proper review and steady maintenance plan for the whole year.',
    '2. Attention is the rarest and purest form of generosity in this passage about reading books slowly every single day.',
    '3. To attend fully to a passage is to give it time and steady focus without rushing ahead too quickly today.',
    '4. Distraction fractures the mind into small tradable pieces instead of letting readers settle into deep and quiet focus.',
    '5. Memory keeps what attention touches over time with care and patience across many slow and deliberate rereadings.',
  ].join('\n');

  const fragHistory = (): ChatTurn[] => [
    { role: 'user', content: 'Explain this passage.' },
    { role: 'assistant', content: 'Prior direct explanation.' },
    { role: 'user', content: 'explain this in 5 points' },
    { role: 'assistant', content: FRAG_PREV },
  ];

  it('never cuts a point mid-phrase (dangling regression)', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('shorten this', fragHistory()));
    expectCoherentNumbered(text, 5);
    expect(text.length).toBeLessThan(FRAG_PREV.length);
    // The old 10-word cut produced "…projects getting a." — banned outright.
    expect(text).not.toMatch(/\bgetting a\./);
    const orig = pointBodies(FRAG_PREV);
    pointBodies(text).forEach((b, i) => {
      const oWords = orig[i].split(/\s+/).filter(Boolean);
      const bWords = b.split(/\s+/).filter(Boolean);
      expect(bWords.length).toBeLessThan(oWords.length);
      // Same proposition: strong overlap, no new content words. (Leading
      // hedges like "Sometimes it would be nice if" are stripped, so exact
      // prefix equality is not required.)
      const oSet = new Set(oWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      const bSet = new Set(bWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      let inter = 0;
      for (const w of bSet) if (oSet.has(w)) inter += 1;
      expect(inter / oSet.size, `weak retention in point ${i + 1}`).toBeGreaterThan(0.25);
      for (const w of [...bSet].filter((x) => x.length > 4)) {
        expect(oSet.has(w), `new word "${w}"`).toBe(true);
      }
    });
    expectNoMeta(text);
  });

  it('shortening stays based on the previous answer, not a fresh summary', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(inputFor('shorten this', fragHistory()));
    expectCoherentNumbered(text, 5);
    expect(text.startsWith('In brief:')).toBe(false);
    // Each shortened point keeps a faithful head: its first content word
    // comes from the original point (hedge-stripping may drop fillers like
    // "Sometimes", so the direction is shortened-head ∈ original).
    const origSets = pointBodies(FRAG_PREV).map(
      (b) => new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0)),
    );
    pointBodies(text).forEach((b, i) => {
      const head = b.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length > 4);
      expect(head, `point ${i + 1} has no head keyword`).toBeDefined();
      expect(origSets[i].has(head as string), `point ${i + 1} head "${head}" not from original`).toBe(true);
    });
    expectNoMeta(text);
  });
});

/**
 * Real-failure regression (Cases A/B/H/I): exact selections taken from the
 * live article, poisoned with the exact unrelated concepts the old runtime
 * leaked (WFI/erratum/M1-M3/camera/Sven/Gambling/Asahi).
 */
const SPTM_SEL =
  'With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor, ' +
  'and these changes certainly go beyond what I could come up with as a newbie in this space. ' +
  'Still, it wasn\u2019t entirely a lost cause.';
const SPTM_SEL_ASCII = SPTM_SEL.replace(/\u2019/g, "'");
const SPTM_POISON = [
  'With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor.',
  'A virtual machine running under the macOS hypervisor would also trigger the erratum logic, ' +
  'and WFI handling makes virtualization difficult to detect. Sven\u2019s tireless work on making ' +
  'the m1n1 hypervisor able to boot and trace macOS is very useful for the builtin camera, ' +
  'with M1-M3 Apple Silicon machines supported in Asahi Linux.',
].join('\n---\n');

const DONATION_SEL =
  'For the most part, I\u2019m submitting my work directly to the respective upstream projects, ' +
  'allowing everyone to take advantage of it. Sometimes it would be nice if certain projects getting ' +
  'a lot of funding were more transparent about how they\u2019re benefitting from the upstream ' +
  'projects\u2019 progress. If you want to support my work on Linux on the M4, I take donations ' +
  'over at LiberaPay or GitHub Sponsors. Please also consider donating to the Asahi Open Collective ' +
  'for more Linux on Apple Silicon mainlining.';
const DONATION_POISON = [
  'For the most part, I\u2019m submitting my work directly to the respective upstream projects.',
  'Gambling that it would be similar to the M1-M3 Apple Silicon machines, WFI handling makes ' +
  'virtualization difficult to detect under the m1n1 hypervisor, and the builtin camera needs ' +
  'Sven\u2019s erratum workaround.',
].join('\n---\n');

const realInputFor = (selection: string, poison: string, userRequest: string, history: ChatTurn[] = []): ExplainInput => ({
  selection,
  nearbyContext: [selection, poison],
  userRequest,
  title: 'Live article',
  history,
});

describe('live-article leakage regression (Cases A/B)', () => {
  it('A: SPTM "in 5 points" contains only selected concepts', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(SPTM_SEL, SPTM_POISON, 'Explain in 5 points'));
    expectCoherentNumbered(text, 5);
    expectGroundedInSel(text, SPTM_SEL);
    expectDistinctPoints(text);
    expectGrammaticalPoints(text);
    // Exact fragments observed in the failed manual verification.
    for (const frag of [
      'To get macOS running under the hypervisor.',
      'These changes certainly go beyond what I could come up.',
      'With as a newbie in this space.',
    ]) {
      expect(text, `banned fragment survived: "${frag}"`).not.toContain(frag);
    }
    for (const m of ['erratum', 'wfi', 'camera', 'sven', 'asahi', 'm1-m3']) {
      expect(text.toLowerCase(), `leaked outside-selection claim: "${m}"`).not.toContain(m);
    }
    expectNoMeta(text);
  });

  it('B: donations "in 5 points" contains only selected concepts', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(DONATION_SEL, DONATION_POISON, 'Explain in 5 points'));
    expectCoherentNumbered(text, 5);
    expectGroundedInSel(text, DONATION_SEL);
    expectDistinctPoints(text);
    expectGrammaticalPoints(text);
    for (const m of ['erratum', 'wfi', 'camera', 'sven', 'm1n1', 'm1-m3', 'gambling']) {
      expect(text.toLowerCase(), `leaked outside-selection claim: "${m}"`).not.toContain(m);
    }
    expectNoMeta(text);
  });

  it('F: bare numeric markers never become point content', async () => {
    const adapter = new DevGroundedAdapter();
    const sel =
      'The kernel enables the bootarg 6 path for tracing. 6. Verbose logging stays on across reboots for diagnosis. ' +
      'Developers watch the hypervisor traces and compare erratum counters over time.';
    const { text } = await adapter.explain(realInputFor(sel, SPTM_POISON, 'Explain in 3 points'));
    expectCoherentNumbered(text, 3);
    for (const b of pointBodies(text)) {
      expect(b.trim(), 'bare numeric point').not.toMatch(/^[[(]?\d+[.)\]]?\.?$/);
      expect(lastWord(b), `numeric tail in: "${b}"`).not.toMatch(/^\d+$/);
    }
    expectNoMeta(text);
  });
});

/**
 * Live kernel-debugging selection (real article wording): a sentence-opening
 * subordinate clause, a "?"-terminated sentence, and a selection truncated
 * inside a parenthetical. "Essentially," is excluded the same way the live
 * selection evidently was (it leaves no trace in the observed output).
 */
const KERNEL_SEL =
  'Since I wasn\u2019t getting any useful output from the kernel, I could only take wild guesses at what was going wrong, right? ' +
  'I decided to try the brute-force method: good old println-debugging. ' +
  'I took the debug_putc assembly routine from m1n1 and adjusted it to print a single \u2018a\u2019 character 4 . ' +
  'I bisected the Linux boot code and landed at the MMU init code (which is still very early';

describe('live kernel-debugging selection (dependent clauses, terminal punctuation, truncation)', () => {
  it('5 points keep subordinate clauses whole, terminals clean, parens balanced', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(KERNEL_SEL, SPTM_POISON, 'Explain in 5 points'));
    expectCoherentNumbered(text, 5);
    expectGroundedInSel(text, KERNEL_SEL);
    expectDistinctPoints(text);
    expectGrammaticalPoints(text);
    expectNoMeta(text);
    // The subordinate clause stays with its matrix clause in one point.
    expectSamePoint(text, 'useful output from the kernel', 'wild guesses');
    // Terminal punctuation is never stacked.
    expectCleanTerminals(text);
    expect(text).toContain('right?');
    expect(text).not.toContain('right?.');
    // The truncated parenthetical is dropped; the main proposition survives.
    expectBalancedParens(text);
    expect(text).toContain('landed at the MMU init code');
    const mmu = pointBodies(text).find((b) => b.includes('MMU init code'));
    expect(mmu, 'MMU point missing').toBeDefined();
    expect(mmu as string).not.toMatch(/[()]/);
    // Exact fragments observed in the failed manual verification.
    for (const frag of [
      'Since I wasn\u2019t getting any useful output from the kernel.',
      'right?.',
      '(which is still very early',
    ]) {
      expect(text, `banned fragment survived: "${frag}"`).not.toContain(frag);
    }
    for (const m of ['erratum', 'wfi', 'camera', 'sven', 'asahi', 'm1-m3']) {
      expect(text.toLowerCase(), `leaked outside-selection claim: "${m}"`).not.toContain(m);
    }
  });

  it.each([
    ['since', 'Since the cache was cold, the first run took minutes. The reboot cleared the fault.', 'cache was cold', 'first run took'],
    ['because', 'Because the driver stalled, the watchdog fired. The reboot cleared the fault.', 'driver stalled', 'watchdog fired'],
    ['although', 'Although the patch landed, the crash persisted. The team regrouped at dawn.', 'patch landed', 'crash persisted'],
    ['while', 'While m1n1 creates mappings, Linux does not map them. The kernel crashed hard.', 'creates mappings', 'does not map'],
    ['if', 'If the register reads zero, the driver skips init. The boot continued smoothly.', 'reads zero', 'skips init'],
    ['unless', 'Unless the flag is set, the core stays asleep. Power draw dropped fast.', 'flag is set', 'stays asleep'],
  ])('subordinate opener "%s" stays joined with its matrix clause', async (_name: string, sel: string, dep: string, matrix: string) => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain({
      selection: sel,
      nearbyContext: [sel],
      userRequest: 'Explain in 2 points',
      title: 't',
      history: [],
    });
    expectCoherentNumbered(text, 2);
    expectGroundedInSel(text, sel);
    expectSamePoint(text, dep, matrix);
    expectCleanTerminals(text);
    expectBalancedParens(text);
    expectNoMeta(text);
  });
});

describe('shorten live shapes (Case B follow-up)', () => {
  const LIVE_PREV = [
    '1. For the most part, I am submitting my work directly to the respective upstream projects for everyone to use.',
    '2. Sometimes it would be nice if certain projects getting a lot of funding were more transparent about upstream benefits.',
    '3. A virtual machine running under the macOS hypervisor would also trigger the erratum logic in nested setups.',
    '4. So Will Deacon suggested an alternative solution where the kernel should not speculate past a WFI instruction.',
    '5. Memory keeps what attention touches over time with care and patience across many slow rereadings.',
  ].join('\n');

  const liveHistory = (): ChatTurn[] => [
    { role: 'user', content: 'Explain this passage.' },
    { role: 'assistant', content: 'Prior direct explanation.' },
    { role: 'user', content: 'Explain in 5 points' },
    { role: 'assistant', content: LIVE_PREV },
  ];

  it('G: live "shorten this" keeps 5 complete propositions, genuinely shorter', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(DONATION_SEL, DONATION_POISON, 'shorten this', liveHistory()));
    expectCoherentNumbered(text, 5);
    expect(text.length).toBeLessThan(LIVE_PREV.length);
    expect(text).not.toMatch(/\bgetting a\./);
    expect(text).not.toMatch(/\bwould also\./);
    expect(text.startsWith('In brief:')).toBe(false);
    const orig = pointBodies(LIVE_PREV);
    pointBodies(text).forEach((b, i) => {
      const oWords = orig[i].split(/\s+/).filter(Boolean);
      const bWords = b.split(/\s+/).filter(Boolean);
      expect(bWords.length).toBeLessThan(oWords.length);
      const oSet = new Set(oWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      const bSet = new Set(bWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      let inter = 0;
      for (const w of bSet) if (oSet.has(w)) inter += 1;
      expect(inter / new Set([...oSet, ...bSet]).size, `weak overlap in point ${i + 1}`).toBeGreaterThan(0.35);
      for (const w of [...bSet].filter((x) => x.length > 4)) {
        expect(oSet.has(w), `new word "${w}"`).toBe(true);
      }
    });
    expectNoMeta(text);
  });
});

describe('unsupported vs supported follow-ups (Cases H/I)', () => {
  const WFI_SEL =
    'With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor. ' +
    'WFI handling makes virtualization difficult to detect because nested virtualization hides the trap.';
  const WFI_CTX = [
    WFI_SEL,
    'If you want to support my work, I take donations over at LiberaPay or GitHub Sponsors for Linux on Apple Silicon.',
  ].join('\n---\n');

  it('H: donations question on a WFI passage says so explicitly', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain({
      selection: WFI_SEL,
      nearbyContext: [WFI_SEL, WFI_CTX],
      userRequest: 'Why does the author mention donations?',
      title: 'Live article',
      history: [],
    });
    expect(text.toLowerCase()).toContain('does not discuss');
    expect(text.toLowerCase()).toContain('donations');
    expect(text).not.toContain('That is what the passage states in its own terms.');
    // Names the gap; invents no donation context of its own.
    expect(text).not.toMatch(/liberapay/i);
    expect(text).not.toMatch(/github sponsors/i);
    expectNoMeta(text);
  });

  it('I: supported virtualization question is answered from the passage', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain({
      selection: WFI_SEL,
      nearbyContext: [WFI_SEL, WFI_CTX],
      userRequest: 'Why is virtualization difficult to detect?',
      title: 'Live article',
      history: [],
    });
    expect(text.toLowerCase()).toContain('virtualiz');
    expect(text).not.toContain('does not discuss');
    expectNoMeta(text);
  });
});

describe('runtime contract: anchor text reaches the task renderer (Case J)', () => {
  const ARTICLE_HTML = `<!doctype html><html><head><title>Live article</title></head><body>
<h1>Live article</h1>
<p>With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor, and these changes certainly go beyond what I could come up with as a newbie in this space. Still, it wasn't entirely a lost cause.</p>
<p>A virtual machine running under the macOS hypervisor would also trigger the erratum logic. Sven's tireless work on the builtin camera and M1-M3 support continued.</p>
</body></html>`;

  it('J: persisted selected_text is the task source; L0/L1 never substitute it', async () => {
    const { svc, identity, cleanup } = await makeServices(ARTICLE_HTML);
    try {
      const { ingestSource } = await import('../apps/api/src/services.js');
      const { publicDns } = await import('./helpers.js');
      const ing = await ingestSource(svc, identity, 'https://example.com/live-article', { dnsResolve: publicDns });
      const selText =
        "With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor, and these " +
        "changes certainly go beyond what I could come up with as a newbie in this space. Still, it wasn't " +
        'entirely a lost cause.';
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selText,
      });
      // Persisted anchor text is exactly the Reader selection.
      const persisted = (await svc.db.query(`SELECT selected_text FROM anchors WHERE id = $1`, [anchor.anchorId])).rows[0] as any;
      expect(String(persisted.selected_text)).toBe(selText);

      // Capture the exact AI input the service builds for the task.
      const seen: ExplainInput[] = [];
      const recording = new DevGroundedAdapter();
      const orig = recording.explain.bind(recording);
      (recording as unknown as { explain: ProviderAdapter['explain'] }).explain = async (
        input: ExplainInput,
      ): Promise<ExplainOutput> => {
        seen.push({ ...input, nearbyContext: [...input.nearbyContext], history: [...(input.history ?? [])] });
        return orig(input);
      };
      svc.router = new ModelRouter(recording);

      const out = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: 'Explain in 5 points',
      });
      expect(seen.length).toBe(1);
      // The renderer receives the exact selection — never the full L0/L1 text.
      expect(seen[0].selection).toBe(selText);
      expect(seen[0].selection).not.toContain('erratum');
      const text = String(out.text);
      expectCoherentNumbered(text, 5);
      for (const m of ['erratum', 'sven', 'camera', 'm1-m3']) {
        expect(text.toLowerCase(), `L0/L1 substitution leak: "${m}"`).not.toContain(m);
      }
      expectNoMeta(text);
    } finally {
      await cleanup();
    }
  });

  it('SPTM_SEL_ASCII sanity: fixture matches the used selection shape', () => {
    expect(SPTM_SEL_ASCII).toContain('m1n1');
    expect(SPTM_SEL_ASCII).not.toMatch(/[’]/);
  });
});

describe('shorten SPTM live shape: required complements survive (Failure 1)', () => {
  const SPTM_PREV = [
    '1. With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor.',
    '2. These changes certainly go beyond what I could come up with as a newbie in this space.',
    '3. Still, it wasn’t entirely a lost cause.',
    '4. —',
    '5. —',
  ].join('\n');

  const sptmHistory = (): ChatTurn[] => [
    { role: 'user', content: 'Explain this passage.' },
    { role: 'assistant', content: 'Prior direct explanation.' },
    { role: 'user', content: 'Explain in 5 points' },
    { role: 'assistant', content: SPTM_PREV },
  ];

  /** Ordered deletion-only check: every candidate word appears in order in the original. */
  const isSubsequence = (orig: string, cand: string): boolean => {
    const o = orig.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const c = cand.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let j = 0;
    for (let i = 0; i < o.length && j < c.length; i += 1) {
      if (o[i] === c[j]) j += 1;
    }
    return j === c.length;
  };

  it('shortened SPTM points keep phrasal-verb and transitive complements', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(SPTM_SEL, SPTM_POISON, 'shorten this', sptmHistory()));
    expectCoherentNumbered(text, 5);
    expect(text.length).toBeLessThan(SPTM_PREV.length);
    expect(text.startsWith('In brief:')).toBe(false);
    const bodies = pointBodies(text);
    const orig = pointBodies(SPTM_PREV);
    // Gap markers unchanged.
    expect(bodies[3]).toMatch(/^—.?$/);
    expect(bodies[4]).toMatch(/^—.?$/);
    // Exact-string backstops for the observed live fragments.
    expect(text).not.toContain('what I could come.');
    expect(text).not.toContain('entirely a lost.');
    for (let i = 0; i < 3; i += 1) {
      const b = bodies[i];
      const oWords = orig[i].split(/\s+/).filter(Boolean);
      const bWords = b.split(/\s+/).filter(Boolean);
      // Genuinely shorter per point.
      expect(bWords.length).toBeLessThan(oWords.length);
      // Complete statement preserving its head proposition.
      const oSet = new Set(oWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      const head = bWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')).find((w) => w.length > 4);
      expect(head, `point ${i + 1} has no head keyword`).toBeDefined();
      expect(oSet.has(head as string), `point ${i + 1} head "${head}" not from original`).toBe(true);
      // Valid extractive subset: ordered, overlapping, no invented wording.
      expect(isSubsequence(orig[i], b), `point ${i + 1} is not an extractive subset`).toBe(true);
      const bSet = new Set(bWords.map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '')));
      let inter = 0;
      for (const w of bSet) if (oSet.has(w)) inter += 1;
      expect(inter / oSet.size, `weak retention in point ${i + 1}`).toBeGreaterThan(0.25);
      for (const w of [...bSet].filter((x) => x.length > 4)) {
        expect(oSet.has(w), `new word "${w}" in point ${i + 1}`).toBe(true);
      }
    }
    // Required complements: keeping the head means keeping the whole phrase.
    for (const b of bodies.slice(0, 3)) {
      if (b.toLowerCase().split(/[^a-z0-9]+/).includes('come')) {
        expect(b.toLowerCase()).toContain('come up with');
      }
      if (b.toLowerCase().split(/[^a-z0-9]+/).includes('lost')) {
        expect(b.toLowerCase()).toContain('lost cause');
      }
    }
    expectNoMeta(text);
  });
});

describe('supported follow-up stays inside the selected passage (Failure 2)', () => {
  const TITLE_POISON = 'Feed: The forgetful CPU (Linux on M4) — This blog post';
  const PREV_POISON = 'Previous article content discussing the Feed and the forgetful CPU at length.';
  const CTX_POISON =
    'The forgetful CPU needs erratum handling and WFI work. Sven’s builtin camera notes and M1-M3 ' +
    'Asahi discussion continued over donations at LiberaPay.';

  const supportedInput = (): ExplainInput => ({
    selection: SPTM_SEL,
    nearbyContext: [SPTM_SEL, SPTM_POISON, CTX_POISON],
    userRequest: 'Why are major changes to m1n1 required?',
    title: TITLE_POISON,
    history: [
      { role: 'user', content: 'Explain this passage.' },
      { role: 'assistant', content: PREV_POISON },
    ],
  });

  it('adapter-level: selected concepts only, no title/context/history leakage, no boilerplate, no full echo', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(supportedInput());
    const lower = text.toLowerCase();
    // Selected-passage concepts present.
    for (const w of ['macos', 'hypervisor', 'major', 'changes', 'required']) {
      expect(lower, `missing selected concept "${w}"`).toContain(w);
    }
    // None of the poison title/context/history/previous-content markers.
    for (const m of ['forgetful', 'feed', 'blog', 'erratum', 'wfi', 'camera', 'sven', 'asahi', 'donation', 'liberapay']) {
      expect(lower, `leaked outside-selection marker: "${m}"`).not.toContain(m);
    }
    expect(text).not.toContain('That is what the passage states in its own terms.');
    expect(text).not.toContain('does not discuss');
    expect(text).not.toContain('Why are major changes to m1n1 required?');
    // Direct subset answer, not the entire passage echoed back.
    expect(text.length).toBeLessThan(SPTM_SEL.length);
    expect(text).not.toContain('lost cause');
    expectNoMeta(text);
  });

  it('service-level: poison article + persisted selection answers from selection only (Case K)', async () => {
    const ARTICLE_HTML = `<!doctype html><html><head><title>Feed: The forgetful CPU (Linux on M4) blog post</title></head><body>
<h1>Feed: The forgetful CPU (Linux on M4)</h1>
<p>With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor, and these changes certainly go beyond what I could come up with as a newbie in this space. Still, it wasn't entirely a lost cause.</p>
<p>A virtual machine running under the macOS hypervisor would also trigger the erratum logic. WFI handling makes virtualization difficult to detect. Sven's tireless work on the builtin camera and M1-M3 support continued.</p>
</body></html>`;
    const { svc, identity, cleanup } = await makeServices(ARTICLE_HTML);
    try {
      const { ingestSource } = await import('../apps/api/src/services.js');
      const { publicDns } = await import('./helpers.js');
      const ing = await ingestSource(svc, identity, 'https://example.com/sptm-poison-article', { dnsResolve: publicDns });
      const selText =
        'With SPTM, major changes to m1n1 are required to get macOS running under the hypervisor, and these ' +
        "changes certainly go beyond what I could come up with as a newbie in this space. Still, it wasn't " +
        'entirely a lost cause.';
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selText,
      });
      const seen: ExplainInput[] = [];
      const recording = new DevGroundedAdapter();
      const orig = recording.explain.bind(recording);
      (recording as unknown as { explain: ProviderAdapter['explain'] }).explain = async (
        input: ExplainInput,
      ): Promise<ExplainOutput> => {
        seen.push({ ...input, nearbyContext: [...input.nearbyContext], history: [...(input.history ?? [])] });
        return orig(input);
      };
      svc.router = new ModelRouter(recording);
      const out = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: 'Why are major changes to m1n1 required?',
      });
      // The renderer receives the exact persisted selection as its source.
      expect(seen.length).toBe(1);
      expect(seen[0].selection).toBe(selText);
      const text = String(out.text);
      const lower = text.toLowerCase();
      for (const w of ['macos', 'hypervisor', 'major', 'changes', 'required']) {
        expect(lower, `missing selected concept "${w}"`).toContain(w);
      }
      for (const m of ['forgetful', 'feed', 'blog', 'erratum', 'wfi', 'camera', 'sven', 'm1-m3']) {
        expect(lower, `leaked outside-selection marker: "${m}"`).not.toContain(m);
      }
      expect(text).not.toContain('That is what the passage states in its own terms.');
      expect(text).not.toContain('does not discuss');
      expect(text.length).toBeLessThan(selText.length);
      expect(text).not.toContain('lost cause');
      expectNoMeta(text);
    } finally {
      await cleanup();
    }
  });

  it('unsupported donation question still says so explicitly (gap path intact)', async () => {
    const adapter = new DevGroundedAdapter();
    // Note: the dev adapter sees the first two nearby-context entries, so the
    // donations-bearing poison sits in slot two (same as the existing H test).
    const { text } = await adapter.explain({
      selection: SPTM_SEL,
      nearbyContext: [SPTM_SEL, CTX_POISON],
      userRequest: 'Why does the author mention donations?',
      title: TITLE_POISON,
      history: [
        { role: 'user', content: 'Explain this passage.' },
        { role: 'assistant', content: PREV_POISON },
      ],
    });
    expect(text.toLowerCase()).toContain('does not discuss');
    expect(text.toLowerCase()).toContain('donations');
    expect(text).not.toContain('That is what the passage states in its own terms.');
    expect(text).not.toMatch(/liberapay/i);
    expectNoMeta(text);
  });
});

describe('exact-N decomposition without gap markers (explicit point count)', () => {
  it('SPTM "Explain in 5 points" yields exactly 5 real, distinct, grounded points', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(SPTM_SEL, SPTM_POISON, 'Explain in 5 points'));
    expect(countPoints(text)).toBe(5);
    expect(text).not.toContain('—');
    const bodies = pointBodies(text);
    expect(bodies.length).toBe(5);
    for (const b of bodies) {
      expect(b.trim().length).toBeGreaterThan(0);
      expect(b).not.toMatch(/^—.?$/);
    }
    expectCoherentNumbered(text, 5);
    expectGrammaticalPoints(text);
    expectCleanTerminals(text);
    expectBalancedParens(text);
    expectDistinctPoints(text);
    expectGroundedInSel(text, SPTM_SEL);
    // No point's token set is a subset of another's (parent/child nesting),
    // on raw bodies and on core propositions with leading conditionals
    // stripped ("With SPTM, X" must not hide X restated elsewhere).
    const tokenSetOf = (b: string): Set<string> =>
      new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const coreOf = (b: string): Set<string> => {
      let t = b.replace(/[.]+$/, '').trim().replace(/^(and|but|or|yet|nor)\b[,\s]*/i, '');
      const m = t.match(/^(with|for|in|on|at|after|before|when|while|since|because|if|unless)\b[^,]*,\s*(.+)$/i);
      if (m) t = m[2];
      return new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    };
    const rawSets = bodies.map(tokenSetOf);
    const coreSets = bodies.map(coreOf);
    for (const sets of [rawSets, coreSets]) {
      for (let i = 0; i < sets.length; i += 1) {
        for (let j = 0; j < sets.length; j += 1) {
          if (i === j) continue;
          let sub = true;
          for (const w of sets[i]) {
            if (!sets[j].has(w)) { sub = false; break; }
          }
          expect(sub, `point ${i + 1} is contained in point ${j + 1}`).toBe(false);
        }
      }
    }
    // The m1n1-specific proposition lives in exactly one point: points 1
    // and 2 must not both restate "major changes to m1n1 are required".
    expect(bodies.filter((b) => /m1n1/i.test(b)).length).toBe(1);
    // Recomposition must land cleanly: no dangling particles/prepositions.
    for (const b of bodies) {
      expect(DANGLING_TAIL.has(lastWord(b)), `dangling ending: "${b}"`).toBe(false);
      expect(lastWord(b), `stranded complement in: "${b}"`).not.toMatch(/^(come|lost|with|up)$/);
    }
    // Required complements survive recombination too.
    for (const b of bodies) {
      const toks = b.toLowerCase().split(/[^a-z0-9]+/);
      if (toks.includes('come')) expect(b.toLowerCase()).toContain('come up with');
      if (toks.includes('lost')) expect(b.toLowerCase()).toContain('lost cause');
    }
    // The decomposition actually happened: purpose and role promoted to
    // their own points instead of gap markers.
    expect(bodies.some((b) => /hypervisor/i.test(b))).toBe(true);
    expect(bodies.some((b) => /^i am a newbie/i.test(b))).toBe(true);
    // No nearby-context leakage.
    for (const m of ['erratum', 'wfi', 'camera', 'sven', 'asahi', 'm1-m3']) {
      expect(text.toLowerCase(), `leaked outside-selection claim: "${m}"`).not.toContain(m);
    }
    expectNoMeta(text);
  });

  it('donation "Explain in 5 points" still yields 5 real points', async () => {
    const adapter = new DevGroundedAdapter();
    const { text } = await adapter.explain(realInputFor(DONATION_SEL, DONATION_POISON, 'Explain in 5 points'));
    expect(countPoints(text)).toBe(5);
    expect(text).not.toContain('—');
    expectCoherentNumbered(text, 5);
    expectGroundedInSel(text, DONATION_SEL);
    expectDistinctPoints(text);
    expectNoMeta(text);
  });
});
