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
