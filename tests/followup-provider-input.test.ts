import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';
import { ModelRouter } from '@bhasya/ai';
import type { ExplainInput, ExplainOutput, ProviderAdapter } from '@bhasya/ai';

/**
 * Follow-up provider-input regression (adapter-agnostic).
 *
 * Uses a recording spy adapter — NOT dev-grounded-1 text semantics — to prove
 * the conversation/context handoff: the provider must receive the exact
 * selection, passage grounding, prior thread history, and the NEW question.
 * The spy returns a deterministic follow-up-path marker so tests can assert
 * the persisted answer came from the follow-up path, not a reused initial.
 */
class RecordingAdapter implements ProviderAdapter {
  readonly id = 'spy-1';
  inputs: ExplainInput[] = [];
  async explain(input: ExplainInput): Promise<ExplainOutput> {
    this.inputs.push({
      ...input,
      nearbyContext: [...input.nearbyContext],
      history: [...(input.history ?? [])],
    });
    if (input.userRequest !== 'Explain this passage.') {
      return {
        text: `FOLLOWUP::Q=${input.userRequest}::SEL=${input.selection}`,
        modelId: this.id,
      };
    }
    return { text: `INITIAL::SEL=${input.selection}`, modelId: this.id };
  }
}

async function makeSpyServices() {
  const base = await makeServices();
  const spy = new RecordingAdapter();
  base.svc.router = new ModelRouter(spy);
  return { ...base, spy };
}

describe('follow-up provider input carries selection + history + new question (Test A)', () => {
  it('anchor A -> initial -> follow-up Q: provider sees A + Q + prior turns; answer is follow-up path', async () => {
    const { svc, identity, spy, cleanup } = await makeSpyServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selA,
      });

      const initial = await explainSelection(svc, identity, { anchorId: anchor.anchorId });
      const T0 = String(initial.text);
      expect(T0.startsWith('INITIAL::')).toBe(true);
      expect(spy.inputs.length).toBe(1);
      expect(spy.inputs[0].selection).toBe(selA);
      expect(spy.inputs[0].userRequest).toBe('Explain this passage.');
      expect(spy.inputs[0].history ?? []).toEqual([]);
      // Passage grounding present (L0 first).
      expect(spy.inputs[0].nearbyContext.length).toBeGreaterThanOrEqual(1);
      expect(spy.inputs[0].nearbyContext[0]).toContain(selA);

      const Q = 'what does this mean in practice?';
      const follow = await explainSelection(svc, identity, {
        anchorId: anchor.anchorId, question: Q, threadId: initial.threadId,
      });
      const T1 = String(follow.text);

      // Same thread retained.
      expect(follow.threadId).toBe(initial.threadId);
      // Provider input contains selection A AND the NEW question.
      expect(spy.inputs.length).toBe(2);
      const fin = spy.inputs[1];
      expect(fin.selection).toBe(selA);
      expect(fin.userRequest).toBe(Q);
      // Prior thread conversation handed off (initial user + assistant).
      expect(fin.history?.length).toBe(2);
      expect(fin.history?.[0]).toMatchObject({ role: 'user', content: 'Explain this passage.' });
      expect(fin.history?.[1]).toMatchObject({ role: 'assistant', content: T0 });
      // Grounding preserved on the follow-up call.
      expect(fin.nearbyContext[0]).toContain(selA);

      // Persisted assistant response is the follow-up path, not a reused initial.
      expect(T1).not.toBe(T0);
      expect(T1.startsWith('FOLLOWUP::')).toBe(true);
      expect(T1).toContain(Q);
      expect(T1).toContain(selA);

      const msgs = (await svc.db.query(
        `SELECT role, content FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`,
        [initial.threadId],
      )).rows as any[];
      expect(msgs.length).toBe(4);
      expect(String(msgs[2].content)).toBe(Q);
      expect(String(msgs[3].content)).toBe(T1);
    } finally {
      await cleanup();
    }
  });
});

describe('independent threads stay isolated (Test B)', () => {
  it('two selections + different follow-ups: each provider call gets its own selection + question + history', async () => {
    const { svc, identity, spy, cleanup } = await makeSpyServices();
    try {
      const ing = await ingestSample(svc, identity);
      const selA = 'rarest and purest form of generosity';
      const selB = 'Readers who annotate remember more';
      const aA = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selA,
      });
      const aB = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: selB,
      });
      expect(aA.anchorId).not.toBe(aB.anchorId);

      const exA = await explainSelection(svc, identity, { anchorId: aA.anchorId });
      const exB = await explainSelection(svc, identity, { anchorId: aB.anchorId });
      expect(exA.threadId).not.toBe(exB.threadId);
      const T0A = String(exA.text);
      const T0B = String(exB.text);
      expect(spy.inputs[0].selection).toBe(selA);
      expect(spy.inputs[1].selection).toBe(selB);

      const QA = 'what does this mean in practice?';
      const QB = 'why does skimming fail here?';
      const fA = await explainSelection(svc, identity, {
        anchorId: aA.anchorId, question: QA, threadId: exA.threadId,
      });
      const fB = await explainSelection(svc, identity, {
        anchorId: aB.anchorId, question: QB, threadId: exB.threadId,
      });
      expect(fA.threadId).toBe(exA.threadId);
      expect(fB.threadId).toBe(exB.threadId);

      expect(spy.inputs.length).toBe(4);
      const inA = spy.inputs[2];
      const inB = spy.inputs[3];
      // Own selection + own question.
      expect(inA.selection).toBe(selA);
      expect(inA.userRequest).toBe(QA);
      expect(inB.selection).toBe(selB);
      expect(inB.userRequest).toBe(QB);
      // Own thread context only — no cross-thread contamination.
      expect(inA.history?.length).toBe(2);
      expect(inA.history?.[1].content).toBe(T0A);
      expect(inA.history?.[1].content).not.toContain(selB);
      expect(inB.history?.length).toBe(2);
      expect(inB.history?.[1].content).toBe(T0B);
      expect(inB.history?.[1].content).not.toContain(selA);
      expect(JSON.stringify(inA.history)).not.toContain(QB);
      expect(JSON.stringify(inB.history)).not.toContain(QA);

      // Persisted answers are follow-up path, each in its own thread.
      expect(String(fA.text).startsWith('FOLLOWUP::')).toBe(true);
      expect(String(fB.text).startsWith('FOLLOWUP::')).toBe(true);
      expect(String(fA.text)).toContain(QA);
      expect(String(fB.text)).toContain(QB);
      expect(String(fA.text)).not.toBe(String(fB.text));

      // Anchor/thread mismatch is rejected before contaminating either thread.
      await expect(
        explainSelection(svc, identity, {
          anchorId: aA.anchorId, question: 'stray?', threadId: exB.threadId,
        }),
      ).rejects.toThrow(/thread anchor mismatch/);
      const countB = (await svc.db.query(
        `SELECT COUNT(*) AS n FROM thread_messages WHERE thread_id = $1`, [exB.threadId],
      )).rows[0] as any;
      // Thread B still holds exactly its initial pair + its own follow-up pair.
      expect(Number(countB.n)).toBe(4);
    } finally {
      await cleanup();
    }
  });
});
