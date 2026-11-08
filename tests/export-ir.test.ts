import { describe, expect, it } from 'vitest';
import {
  EXPORT_IMPLICIT_QUESTION,
  EXPORT_MAX_MESSAGE_CHARS,
  EXPORT_MAX_MESSAGES,
  EXPORT_MAX_PASSAGES,
  EXPORT_MAX_THREADS,
  EXPORT_MEDIA_NOTE,
  buildExportIR,
  type ExportInput,
} from '../apps/api/src/export-ir.js';
import { sortNodesForExport } from '../apps/api/src/export-service.js';

function baseInput(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    version: {
      title: 'The Craft of Reading',
      sourceUrl: 'https://example.com/craft-of-reading',
      versionNo: 1,
      importedAt: '2026-10-04T00:00:00.000Z',
      contentHash: 'abc123',
      passageCount: 4,
    },
    nodes: [
      { node_type: 'heading', depth: 2, structural_path: '/doc/sec[1]/h[1]', text: 'Attention' },
      { node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[1]', text: 'First paragraph.' },
      { node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[2]', text: 'Second paragraph.' },
    ],
    threads: [],
    generatedAt: '2026-10-04T01:00:00.000Z',
    ...overrides,
  };
}

function thread(overrides: any = {}) {
  return {
    id: 'thread-1',
    title: 'Passage thread',
    createdAt: '2026-10-04T01:01:00.000Z',
    anchorSelectedText: 'rarest and purest form of generosity',
    anchorStructuralPath: '/doc/sec[1]/p[1]',
    sectionLabel: 'Attention',
    messages: [
      { role: 'user', content: EXPORT_IMPLICIT_QUESTION, model_id: null, created_at: '2026-10-04T01:01:01.000Z' },
      { role: 'assistant', content: 'Attention means giving time.', model_id: 'dev-grounded-1', created_at: '2026-10-04T01:01:02.000Z' },
    ],
    evidence: [{ quote: 'Attention is the rarest…', scope_level: 'L0', rank: 0, passagePath: '/doc/sec[1]/p[1]' }],
    citations: [{ label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' }],
    ...overrides,
  };
}

describe('buildExportIR: article shaping', () => {
  it('keeps headings wholesale and orders leaf nodes by path', () => {
    const ir = buildExportIR(baseInput());
    expect(ir.nodes.map((n) => n.kind)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(ir.document.title).toBe('The Craft of Reading');
    expect(ir.totals.nodeCount).toBe(3);
  });

  it('drops structural and empty nodes without rendering them', () => {
    const ir = buildExportIR(baseInput({
      nodes: [
        { node_type: 'document', depth: 0, structural_path: '/doc', text: '' },
        { node_type: 'section', depth: 1, structural_path: '/doc/sec[1]', text: '' },
        { node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[1]', text: '' },
        { node_type: 'paragraph', depth: 2, structural_path: '/doc/sec[1]/p[2]', text: 'Kept.' },
      ],
    }));
    expect(ir.nodes).toEqual([{ kind: 'paragraph', text: 'Kept.' }]);
  });

  it('caps leaf passages and records the omission', () => {
    const nodes = Array.from({ length: EXPORT_MAX_PASSAGES + 25 }, (_, i) => ({
      node_type: 'paragraph', depth: 2, structural_path: `/doc/sec[1]/p[${i + 1}]`, text: `Para ${i + 1}.`,
    }));
    const ir = buildExportIR(baseInput({ nodes }));
    expect(ir.nodes.length).toBe(EXPORT_MAX_PASSAGES);
    expect(ir.truncation.passagesOmitted).toBe(25);
  });

  it('sets the media note only when figure/caption content exists', () => {
    expect(buildExportIR(baseInput()).mediaNote).toBeNull();
    const withCaption = buildExportIR(baseInput({
      nodes: [{ node_type: 'caption', depth: 2, structural_path: '/doc/sec[1]/p[9]', text: 'Figure one.' }],
    }));
    expect(withCaption.mediaNote).toBe(EXPORT_MEDIA_NOTE);
    expect(withCaption.nodes).toEqual([{ kind: 'caption', text: 'Figure one.' }]);
  });
});

describe('buildExportIR: threads and messages', () => {
  it('drops the boilerplate lead question and keeps anchor context', () => {
    const ir = buildExportIR(baseInput({ threads: [thread()] }));
    expect(ir.threads.length).toBe(1);
    const t = ir.threads[0];
    expect(t.position).toBe(1);
    expect(t.anchorExcerpt).toBe('rarest and purest form of generosity');
    expect(t.anchorPath).toBe('/doc/sec[1]/p[1]');
    expect(t.sectionLabel).toBe('Attention');
    expect(t.messages.map((m) => m.role)).toEqual(['assistant']);
    expect(t.evidence[0]).toMatchObject({ scopeLevel: 'L0', rank: 0 });
    expect(t.citations).toEqual([{ label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' }]);
  });

  it('keeps follow-up questions and answers in persisted order', () => {
    const ir = buildExportIR(baseInput({
      threads: [thread({
        messages: [
          { role: 'user', content: EXPORT_IMPLICIT_QUESTION, model_id: null, created_at: 't0' },
          { role: 'assistant', content: 'First answer.', model_id: 'm', created_at: 't1' },
          { role: 'user', content: 'Why does skimming fail?', model_id: null, created_at: 't2' },
          { role: 'assistant', content: 'Because attention needs time.', model_id: 'm', created_at: 't3' },
        ],
      })],
    }));
    const roles = ir.threads[0].messages.map((m) => `${m.role}:${m.content}`);
    expect(roles).toEqual([
      'assistant:First answer.',
      'user:Why does skimming fail?',
      'assistant:Because attention needs time.',
    ]);
    expect(ir.totals.messageCount).toBe(3);
  });

  it('keeps an explicit first question that is not the boilerplate', () => {
    const ir = buildExportIR(baseInput({
      threads: [thread({
        messages: [{ role: 'user', content: 'What does this mean?', model_id: null, created_at: 't0' }],
      })],
    }));
    expect(ir.threads[0].messages.map((m) => m.role)).toEqual(['user']);
  });

  it('caps threads, total messages, and overlong content with notices', () => {
    const many = Array.from({ length: EXPORT_MAX_THREADS + 4 }, (_, i) =>
      thread({ id: `t-${i}`, messages: [{ role: 'user', content: `Q${i}?`, model_id: null, created_at: `t${i}` }] }),
    );
    const big = thread({
      id: 'big',
      messages: [{ role: 'assistant', content: `x`.repeat(EXPORT_MAX_MESSAGE_CHARS + 500), model_id: 'm', created_at: 't' }],
    });
    const ir = buildExportIR(baseInput({ threads: [...many, big] }));
    expect(ir.threads.length).toBe(EXPORT_MAX_THREADS);
    expect(ir.truncation.threadsOmitted).toBe(5);
    // Message budget applies across the kept threads.
    expect(ir.totals.messageCount).toBeLessThanOrEqual(EXPORT_MAX_MESSAGES);
    const long = buildExportIR(baseInput({ threads: [big] }));
    expect(long.threads[0].messages[0].truncated).toBe(true);
    expect(long.threads[0].messages[0].content).toMatch(/\[truncated\]$/);
    expect(long.truncation.charsTruncated).toBe(500);
  });

  it('is deterministic for the same rows', () => {
    const input = baseInput({ threads: [thread()] });
    expect(buildExportIR(input)).toEqual(buildExportIR(baseInput({ threads: [thread()] })));
  });
});

describe('buildExportIR: presentation dedupe', () => {
  it('collapses identical evidence and citations within a thread only', () => {
    const ir = buildExportIR(baseInput({
      threads: [
        thread({
          evidence: [
            { quote: 'Same quote.', scope_level: 'L0', rank: 0, passagePath: '/doc/sec[1]/p[1]' },
            { quote: 'Same  quote.', scope_level: 'L0', rank: 1, passagePath: '/doc/sec[1]/p[1]' },
            { quote: 'Same quote.', scope_level: 'L1', rank: 2, passagePath: '/doc/sec[1]/p[1]' },
            { quote: 'Same quote.', scope_level: 'L0', rank: 3, passagePath: '/doc/sec[1]/p[2]' },
            { quote: 'Distinct quote.', scope_level: 'L0', rank: 4, passagePath: '/doc/sec[1]/p[1]' },
          ],
          citations: [
            { label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' },
            { label: 'Cited passage', passagePath: '/doc/sec[1]/p[1]' },
            { label: 'Cited passage', passagePath: '/doc/sec[1]/p[2]' },
          ],
        }),
        thread({ id: 'thread-2' }),
      ],
    }));
    expect(ir.threads[0].evidence).toHaveLength(4);
    expect(ir.threads[0].evidence.map((e) => e.scopeLevel)).toEqual(['L0', 'L1', 'L0', 'L0']);
    expect(ir.threads[0].citations).toHaveLength(2);
    // Identical entries in another thread are kept: no cross-thread dedupe.
    expect(ir.threads[1].evidence).toHaveLength(1);
    expect(ir.threads[1].citations).toHaveLength(1);
    // Persisted messages survive presentation dedupe.
    expect(ir.threads[0].messages.map((m) => m.content)).toEqual(['Attention means giving time.']);
  });
});

describe('hierarchical preorder sort (document order, not path strings)', () => {
  const row = (id: string, parent_id: string | null, ordinal: number, extra: Record<string, unknown> = {}) => ({
    id, parent_id, ordinal, node_type: 'paragraph', depth: 2, structural_path: '', text: 't', ...extra,
  });

  it('orders parents before descendants and subtrees before next siblings', () => {
    const root = row('root', null, 0, { node_type: 'document', depth: 0 });
    const s1 = row('s1', 'root', 1, { node_type: 'section', depth: 1 });
    const s2 = row('s2', 'root', 2, { node_type: 'section', depth: 1 });
    const p1 = row('p1', 's1', 1);
    const p2 = row('p2', 's1', 2);
    const h2 = row('h2', 's2', 0, { node_type: 'heading' });
    const p3 = row('p3', 's2', 1);
    const shuffled = [p3, s2, p1, root, p2, h2, s1];
    expect(sortNodesForExport(shuffled).map((r) => r.id)).toEqual([
      'root', 's1', 'p1', 'p2', 's2', 'h2', 'p3',
    ]);
  });

  it('compares double-digit ordinals numerically and supports nesting', () => {
    const root = row('root', null, 0, { node_type: 'document', depth: 0 });
    const s2 = row('s2', 'root', 2, { node_type: 'section', depth: 1 });
    const s10 = row('s10', 'root', 10, { node_type: 'section', depth: 1 });
    const p10 = row('p10', 's10', 1);
    const sub = row('sub', 's2', 1, { node_type: 'section', depth: 2 });
    const deep = row('deep', 'sub', 1, { depth: 3 });
    const p2 = row('p2', 's2', 2);
    const shuffled = [p10, s10, deep, p2, sub, s2, root];
    expect(sortNodesForExport(shuffled).map((r) => r.id)).toEqual([
      'root', 's2', 'sub', 'deep', 'p2', 's10', 'p10',
    ]);
  });
});

describe('buildExportIR: appendix location and message fidelity', () => {
  it('builds a human location from section label and leaf ordinal', () => {
    const ir = buildExportIR(baseInput({
      threads: [thread({ sectionLabel: 'Attention', anchorLeafOrdinal: 2 })],
    }));
    expect(ir.threads[0].location).toBe('Attention – passage 2');
    expect(ir.threads[0].anchorPath).toBe('/doc/sec[1]/p[1]');
  });

  it('leaves location null without a label or ordinal', () => {
    const ir = buildExportIR(baseInput({ threads: [thread({ sectionLabel: null })] }));
    expect(ir.threads[0].location).toBeNull();
  });

  it('passes persisted messages through byte-faithfully, even when fragmented', () => {
    const fragmented = 'First, the surface. Second the deeper. Third, the persists after.';
    const ir = buildExportIR(baseInput({
      threads: [thread({
        messages: [
          { role: 'user', content: 'List three points.', model_id: null, created_at: 't0' },
          { role: 'assistant', content: fragmented, model_id: 'dev-grounded-1', created_at: 't1' },
        ],
      })],
    }));
    expect(ir.threads[0].messages[1].content).toBe(fragmented);
    expect(ir.threads[0].messages[1].modelId).toBe('dev-grounded-1');
  });
});
