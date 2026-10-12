/**
 * Reading-session PDF export — intermediate representation (ExportIR).
 *
 * Pure data transformation with no PDF, storage, network, or database
 * knowledge: the export service fetches canonical rows (document versions,
 * nodes, passages, anchors, threads, messages, evidence, citations) and this
 * module shapes them into an ordered, capped, renderer-ready structure.
 *
 * Source of truth is the canonical Bhasya model. The raw stored HTML is
 * never parsed here. Anything the canonical model cannot represent
 * (author/byline, images, tables, rich links, page styling) is omitted
 * cleanly — never reconstructed.
 */

export const EXPORT_MAX_PASSAGES = 200;
export const EXPORT_MAX_THREADS = 50;
export const EXPORT_MAX_MESSAGES = 200;
export const EXPORT_MAX_MESSAGE_CHARS = 20000;

/**
 * Boilerplate persisted as the first user message of an initial explanation
 * (see prepareExplainState: `args.question?.trim() || 'Explain this passage.'`).
 * It carries no user intent, so the builder drops it when it leads a thread —
 * the anchor excerpt above already states what was asked about.
 */
export const EXPORT_IMPLICIT_QUESTION = 'Explain this passage.';

/** Set when figure/caption nodes exist: raster images are out of scope. */
export const EXPORT_MEDIA_NOTE =
  'Figures and images from the original page are not included in this export.';

export type ExportNodeKind = 'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'caption';

export interface ExportNode {
  kind: ExportNodeKind;
  text: string;
}

export interface ExportDocMeta {
  title: string;
  sourceUrl: string;
  versionNo: number;
  importedAt: string;
  contentHash: string;
  passageCount: number;
}

export interface ExportMessage {
  role: 'user' | 'assistant';
  content: string;
  modelId: string | null;
  truncated: boolean;
}

export interface ExportEvidence {
  quote: string;
  scopeLevel: string;
  rank: number;
  passagePath: string;
}

export interface ExportCitation {
  label: string;
  passagePath: string;
}

export interface ExportThread {
  position: number;
  anchorExcerpt: string;
  anchorPath: string;
  sectionLabel: string | null;
  threadCreatedAt: string;
  messages: ExportMessage[];
  evidence: ExportEvidence[];
  citations: ExportCitation[];
}

export interface ExportTruncation {
  passagesOmitted: number;
  threadsOmitted: number;
  messagesOmitted: number;
  charsTruncated: number;
}

export interface ExportIR {
  document: ExportDocMeta;
  nodes: ExportNode[];
  threads: ExportThread[];
  mediaNote: string | null;
  generatedAt: string;
  truncation: ExportTruncation;
  totals: { nodeCount: number; threadCount: number; messageCount: number };
}

/** Raw canonical node row as read from document_nodes (ordered by path). */
export interface ExportInputNode {
  node_type: string;
  depth: number;
  structural_path: string;
  text: string;
}

/** One thread with its persisted relations, pre-ordered by the service. */
export interface ExportInputThread {
  id: string;
  title: string;
  createdAt: string;
  anchorSelectedText: string;
  anchorStructuralPath: string;
  sectionLabel: string | null;
  messages: Array<{ role: string; content: string; model_id: string | null; created_at: string }>;
  evidence: Array<{ quote: string; scope_level: string; rank: number; passagePath: string }>;
  citations: Array<{ label: string; passagePath: string }>;
}

export interface ExportInput {
  version: {
    title: string;
    sourceUrl: string;
    versionNo: number;
    importedAt: string;
    contentHash: string;
    passageCount: number;
  };
  nodes: ExportInputNode[];
  threads: ExportInputThread[];
  generatedAt?: string;
}

const RENDERABLE = new Set(['heading', 'paragraph', 'list_item', 'quote', 'code', 'caption']);

function cleanText(text: unknown): string {
  return typeof text === 'string' ? text : '';
}

/**
 * Shape canonical rows + the caller's persisted session rows into an
 * ordered, capped ExportIR. Deterministic: same rows in, same IR out.
 * Structural nodes (document/section/empty text) never render; headings are
 * kept wholesale while leaf text nodes are capped at EXPORT_MAX_PASSAGES.
 */
export function buildExportIR(input: ExportInput): ExportIR {
  const nodes: ExportNode[] = [];
  let passagesOmitted = 0;
  let leafCount = 0;
  let hasMedia = false;
  for (const n of input.nodes) {
    const text = cleanText(n.text);
    if (n.node_type === 'figure' || n.node_type === 'caption') hasMedia = true;
    if (!RENDERABLE.has(n.node_type) || text.length === 0) continue;
    if (n.node_type === 'heading') {
      nodes.push({ kind: 'heading', text });
      continue;
    }
    if (leafCount >= EXPORT_MAX_PASSAGES) {
      passagesOmitted += 1;
      continue;
    }
    leafCount += 1;
    nodes.push({ kind: n.node_type as ExportNodeKind, text });
  }

  const threads: ExportThread[] = [];
  let threadsOmitted = 0;
  let messagesOmitted = 0;
  let charsTruncated = 0;
  let messageCount = 0;
  let messageBudget = EXPORT_MAX_MESSAGES;
  const cappedThreads = input.threads.slice(0, EXPORT_MAX_THREADS);
  threadsOmitted = input.threads.length - cappedThreads.length;
  cappedThreads.forEach((t, i) => {
    const messages: ExportMessage[] = [];
    let list = t.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    // Drop the boilerplate lead question; the anchor excerpt states the ask.
    if (list.length > 0 && list[0].role === 'user' && (list[0].content ?? '').trim() === EXPORT_IMPLICIT_QUESTION) {
      list = list.slice(1);
    }
    if (list.length > messageBudget) {
      messagesOmitted += list.length - messageBudget;
      list = list.slice(0, messageBudget);
    }
    messageBudget -= list.length;
    for (const m of list) {
      const content = cleanText(m.content);
      if (content.length > EXPORT_MAX_MESSAGE_CHARS) {
        charsTruncated += content.length - EXPORT_MAX_MESSAGE_CHARS;
        messages.push({
          role: m.role as 'user' | 'assistant',
          content: `${content.slice(0, EXPORT_MAX_MESSAGE_CHARS)}… [truncated]`,
          modelId: typeof m.model_id === 'string' ? m.model_id : null,
          truncated: true,
        });
      } else {
        messages.push({
          role: m.role as 'user' | 'assistant',
          content,
          modelId: typeof m.model_id === 'string' ? m.model_id : null,
          truncated: false,
        });
      }
    }
    messageCount += messages.length;
    threads.push({
      position: i + 1,
      anchorExcerpt: cleanText(t.anchorSelectedText),
      anchorPath: cleanText(t.anchorStructuralPath),
      sectionLabel: typeof t.sectionLabel === 'string' && t.sectionLabel.length > 0 ? t.sectionLabel : null,
      threadCreatedAt: cleanText(t.createdAt),
      messages,
      evidence: t.evidence.map((e) => ({
        quote: cleanText(e.quote),
        scopeLevel: cleanText(e.scope_level) || 'L0',
        rank: typeof e.rank === 'number' ? e.rank : 0,
        passagePath: cleanText(e.passagePath),
      })),
      citations: t.citations.map((c) => ({
        label: cleanText(c.label) || 'Cited passage',
        passagePath: cleanText(c.passagePath),
      })),
    });
  });

  return {
    document: {
      title: cleanText(input.version.title) || 'Untitled document',
      sourceUrl: cleanText(input.version.sourceUrl),
      versionNo: typeof input.version.versionNo === 'number' ? input.version.versionNo : 1,
      importedAt: cleanText(input.version.importedAt),
      contentHash: cleanText(input.version.contentHash),
      passageCount: typeof input.version.passageCount === 'number' ? input.version.passageCount : 0,
    },
    nodes,
    threads,
    mediaNote: hasMedia ? EXPORT_MEDIA_NOTE : null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    truncation: { passagesOmitted, threadsOmitted, messagesOmitted, charsTruncated },
    totals: { nodeCount: nodes.length, threadCount: threads.length, messageCount },
  };
}
