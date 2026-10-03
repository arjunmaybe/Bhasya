import { contextFingerprint, sha256Hex, textHash } from './hash.js';
import type { AnchorContract, CanonicalDocument, CanonicalNode, CanonicalPassage, WebLocator } from './types.js';

function newUuid(): string {
  // Web Crypto (Node 20+ and Cloudflare Workers) — no `node:crypto` import.
  return globalThis.crypto.randomUUID();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractBlocks(html: string): Array<{ tag: string; text: string }> {
  const blocks: Array<{ tag: string; text: string }> = [];
  const re = /<(h[1-6]|p|li|blockquote|pre|figcaption|div)[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (text.length >= 1) blocks.push({ tag, text });
  }
  return blocks;
}

function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1\s*>/i);
  return m ? stripTags(m[1]).slice(0, 200) : 'Untitled document';
}

/**
 * Normalize imported HTML into the canonical document representation.
 * Contract: Document → Heading/Section → Paragraph… with identity, ordering,
 * structural path, parent relationship. Passages map 1:1 to leaf text blocks
 * in Phase 1 (no chunk merging across nodes).
 */
export function normalizeHtmlToCanonical(html: string, url = ''): CanonicalDocument {
  const title = titleOf(html);
  const blocks = extractBlocks(html);
  const maxBlocks = 500;
  const kept = blocks.filter((b) => b.text.length > 0).slice(0, maxBlocks);

  const nodes: CanonicalNode[] = [];
  const passages: CanonicalPassage[] = [];

  const rootId = newUuid();
  nodes.push({
    id: rootId, parentId: null, nodeType: 'document', ordinal: 0, depth: 0,
    structuralPath: '/doc', text: '', attrs: { url },
  });

  let sectionIdx = 0;
  let currentSectionId = rootId;
  let currentSectionPath = '/doc';
  let paraOrdinal = 0;

  const ensureSection = () => {
    if (currentSectionId === rootId || nodes.find((n) => n.id === currentSectionId)?.nodeType !== 'section') return;
  };
  void ensureSection;

  for (const b of kept) {
    if (/^h[1-6]$/.test(b.tag)) {
      sectionIdx += 1;
      currentSectionPath = `/doc/sec[${sectionIdx}]`;
      const secId = newUuid();
      nodes.push({
        id: secId, parentId: rootId, nodeType: 'section', ordinal: sectionIdx,
        depth: 1, structuralPath: currentSectionPath, text: '', attrs: {},
      });
      const hId = newUuid();
      const hPath = `${currentSectionPath}/h[${sectionIdx}]`;
      nodes.push({
        id: hId, parentId: secId, nodeType: 'heading', ordinal: 0, depth: 2,
        structuralPath: hPath, text: b.text, attrs: {},
      });
      paraOrdinal = 0;
      currentSectionId = secId;
    } else {
      if (currentSectionId === rootId) {
        sectionIdx += 1;
        currentSectionPath = `/doc/sec[${sectionIdx}]`;
        const secId = newUuid();
        nodes.push({
          id: secId, parentId: rootId, nodeType: 'section', ordinal: sectionIdx,
          depth: 1, structuralPath: currentSectionPath, text: '', attrs: {},
        });
        currentSectionId = secId;
        paraOrdinal = 0;
      }
      paraOrdinal += 1;
      const nodeType = b.tag === 'li' ? 'list_item'
        : b.tag === 'blockquote' ? 'quote'
        : b.tag === 'pre' ? 'code'
        : b.tag === 'figcaption' ? 'caption' : 'paragraph';
      const nId = newUuid();
      const nPath = `${currentSectionPath}/p[${paraOrdinal}]`;
      nodes.push({
        id: nId, parentId: currentSectionId, nodeType, ordinal: paraOrdinal,
        depth: 2, structuralPath: nPath, text: b.text, attrs: {},
      });
      passages.push({
        nodeId: nId, ordinal: 0, structuralPath: nPath, text: b.text, textHash: textHash(b.text),
      });
    }
  }

  // Fallback: whole body as one paragraph if no blocks parsed.
  if (passages.length === 0) {
    const text = stripTags(html).slice(0, 20000) || 'Empty document.';
    const secId = newUuid();
    nodes.push({
      id: secId, parentId: rootId, nodeType: 'section', ordinal: 1,
      depth: 1, structuralPath: '/doc/sec[1]', text: '', attrs: {},
    });
    const nId = newUuid();
    nodes.push({
      id: nId, parentId: secId, nodeType: 'paragraph', ordinal: 1,
      depth: 2, structuralPath: '/doc/sec[1]/p[1]', text, attrs: {},
    });
    passages.push({ nodeId: nId, ordinal: 0, structuralPath: '/doc/sec[1]/p[1]', text, textHash: textHash(text) });
  }

  const contentHash = sha256Hex(passages.map((p) => p.textHash).join('\n'));
  return { title, lang: 'en', nodes, passages, contentHash };
}

/** Locate selected text inside a passage: offsets + prefix/suffix context. */
export function locateSelection(passageText: string, selectedText: string): { start: number; end: number; prefix: string; suffix: string } | null {
  const normHay = passageText;
  const idx = normHay.indexOf(selectedText);
  if (idx >= 0) {
    return {
      start: idx, end: idx + selectedText.length,
      prefix: normHay.slice(Math.max(0, idx - 120), idx),
      suffix: normHay.slice(idx + selectedText.length, idx + selectedText.length + 120),
    };
  }
  // Fallback: whitespace-collapsed match.
  const canon = (s: string) => s.replace(/\s+/g, ' ').trim();
  const cHay = canon(passageText);
  const cSel = canon(selectedText);
  const cIdx = cHay.indexOf(cSel);
  if (cIdx < 0) return null;
  return { start: cIdx, end: cIdx + cSel.length, prefix: cHay.slice(Math.max(0, cIdx - 120), cIdx), suffix: cHay.slice(cIdx + cSel.length, cIdx + cSel.length + 120) };
}

/** Find the best passage for a selection (exact substring, longest match wins). */
export function findPassageForSelection(
  passages: Array<{ id: string; nodeId: string; structuralPath: string; text: string }>,
  selectedText: string,
): { passage: (typeof passages)[number]; start: number; end: number; prefix: string; suffix: string } | null {
  const sel = selectedText.trim();
  if (!sel) return null;
  let best: { passage: (typeof passages)[number]; start: number; end: number; prefix: string; suffix: string } | null = null;
  for (const p of passages) {
    const loc = locateSelection(p.text, sel);
    if (loc && (!best || sel.length >= best.end - best.start)) {
      best = { passage: p, ...loc };
      if (loc.start === 0 && loc.end === p.text.length) break;
    }
  }
  return best;
}

/** Build the architectural anchor for a selection within a document version. */
export function buildAnchor(args: {
  documentVersionId: string;
  passage: { id: string; nodeId: string; structuralPath: string; text: string };
  selectedText: string;
  cssHint?: string;
}): AnchorContract {
  const sel = args.selectedText.trim();
  const loc = locateSelection(args.passage.text, sel);
  if (!loc) throw new Error('selection not found in passage');
  const fingerprint = contextFingerprint({
    structuralPath: args.passage.structuralPath,
    prefix: loc.prefix, selected: sel, suffix: loc.suffix,
  });
  const locator: WebLocator = {
    kind: 'web-html',
    passageId: args.passage.id,
    nodePath: args.passage.structuralPath,
    startOffset: loc.start,
    endOffset: loc.end,
    prefix: loc.prefix,
    suffix: loc.suffix,
    cssHint: args.cssHint ?? `[data-passage-id="${args.passage.id}"]`,
  };
  return {
    documentVersionId: args.documentVersionId,
    nodeId: args.passage.nodeId,
    passageId: args.passage.id,
    selectedText: sel,
    startOffset: loc.start,
    endOffset: loc.end,
    textHash: textHash(sel),
    structuralPath: args.passage.structuralPath,
    contextFingerprint: fingerprint,
    locator,
  };
}
