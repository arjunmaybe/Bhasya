import { contextFingerprint, sha256Hex, textHash } from './hash.js';
import type { AnchorContract, CanonicalDocument, CanonicalNode, CanonicalPassage, WebLocator } from './types.js';

function newUuid(): string {
  // Web Crypto (Node 20+ and Cloudflare Workers) — no `node:crypto` import.
  return globalThis.crypto.randomUUID();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  middot: '·', times: '×', divide: '÷', plusmn: '±', deg: '°',
  para: '¶', sect: '§',
};

function codepointToString(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(Math.floor(n));
  } catch {
    return '';
  }
}

function decodeEntities(s: string): string {
  const named = s.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) => {
    const hit = NAMED_ENTITIES[String(name).toLowerCase()];
    return hit !== undefined ? hit : m;
  });
  const decimal = named.replace(/&#(\d+);/g, (m, digits) => {
    const ch = codepointToString(Number(digits));
    return ch === '' ? m : ch;
  });
  return decimal.replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
    const ch = codepointToString(parseInt(String(hex), 16));
    return ch === '' ? m : ch;
  });
}

/**
 * Inline elements contribute no text of their own: the browser concatenates
 * their content with surrounding text, so removing them must not insert a
 * space (`word1<b>word2</b>` renders as `word1word2`, and `</b>,` renders
 * with no gap before the comma). Inserting a space here created phantom
 * spaces in canonical text that made browser-visible selections unresolvable.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code',
  'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark', 'q', 's',
  'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'tt',
  'u', 'var',
]);

/**
 * Boundary elements separate content in rendered text (block breaks and
 * <br> surface as whitespace in selections), so they contribute one
 * separator. Unknown elements are inline by default in HTML; void/replaced
 * elements without text (img, input, …) likewise contribute nothing — both
 * default to no separator to match the browser.
 */
const SEPARATOR_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'details', 'div',
  'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/**
 * Non-article markup whose inner text must never enter canonical content:
 * scripts (analytics, JSON-LD, app state), stylesheets, inert template and
 * noscript bodies, navigation and sidebar link lists, and the whole <head>
 * section. Header/footer text is kept: it can hold legitimate headings and
 * footnotes, and document ordering places it correctly. Applied before block
 * extraction so container pairing can't span these regions, and defensively
 * inside stripTags so no extraction path leaks website code as article text.
 */
function removeNonContent(html: string): string {
  return html
    .replace(/<head[\s>][\s\S]*?<\/head\s*>/gi, '')
    .replace(/<(script|style|noscript|template|nav|aside)[\s>][\s\S]*?<\/\1\s*>/gi, '')
    // The source uses this span for a touch-only alternative instruction.
    // Keep the default pointer instruction in canonical reading text.
    .replace(/<span\b([^>]*)>[\s\S]*?<\/span\s*>/gi, (match, attrs: string) => {
      const classMatch = attrs.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
      const classes = classMatch?.[2].split(/\s+/) ?? [];
      return classes.includes('hint-touch') ? '' : match;
    });
}

function stripTags(html: string): string {
  const content = removeNonContent(html);
  const noComments = content
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<![^>]*>/g, '')
    .replace(/<\?[^>]*\?>/g, '');
  const deTagged = noComments.replace(/<\/?([A-Za-z][A-Za-z0-9]*)[^>]*>/g, (m, tag) => {
    const t = String(tag).toLowerCase();
    if (INLINE_TAGS.has(t)) return '';
    if (SEPARATOR_TAGS.has(t)) return ' ';
    return '';
  });
  return decodeEntities(deTagged).replace(/\s+/g, ' ').trim();
}

/** A div wrapping other block-level content is a container, not a paragraph:
 * harvesting it whole would swallow or duplicate the text its block children
 * already yield. A div with only inline content is a legitimate leaf (common
 * article markup) and is kept. */
const BLOCK_OPEN_RE =
  /<(p|div|h[1-6]|li|ul|ol|blockquote|pre|figure|figcaption|table|section|article|header|footer|nav|aside)\b/i;

/**
 * Harvest a container div's content in document order: leading direct text,
 * then nested blocks (recursively, so deeper containers behave the same),
 * then trailing direct text. Either edge may be absent; whitespace-only
 * edges yield nothing. The tail split uses the last block *close tag* (not
 * the last '>') so literal '>' in text is preserved.
 */
const BLOCK_CLOSE_RE =
  /<\/(p|div|h[1-6]|li|ul|ol|blockquote|pre|figure|figcaption|table|section|article|header|footer|nav|aside)\s*>/gi;

function appendDivContainer(blocks: Array<{ tag: string; text: string }>, inner: string): void {
  const firstIdx = inner.search(BLOCK_OPEN_RE);
  const lead = stripTags(firstIdx < 0 ? inner : inner.slice(0, firstIdx));
  if (lead.length >= 1) blocks.push({ tag: 'div', text: lead });
  if (firstIdx < 0) return;
  let tailStart = -1;
  for (const cm of inner.matchAll(BLOCK_CLOSE_RE)) tailStart = (cm.index ?? 0) + cm[0].length;
  if (tailStart < 0) {
    // Block opens but no closes: nothing nested is matchable, so keep the
    // remainder as text rather than dropping it silently.
    const tail = stripTags(inner.slice(firstIdx));
    if (tail.length >= 1) blocks.push({ tag: 'div', text: tail });
    return;
  }
  const middle = inner.slice(firstIdx, tailStart);
  for (const b of extractBlocks(middle)) blocks.push(b);
  const tail = stripTags(inner.slice(tailStart));
  if (tail.length >= 1) blocks.push({ tag: 'div', text: tail });
}

function findMatchingDivClose(
  html: string,
  contentStart: number,
): { start: number; end: number } | null {
  // Ignore comments so tag-like text inside them cannot affect nesting.
  const tokens = /<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi;
  tokens.lastIndex = contentStart;

  let depth = 1;
  let token: RegExpExecArray | null;

  while ((token = tokens.exec(html)) !== null) {
    const value = token[0];

    if (value.startsWith('<!--')) continue;

    if (/^<\/div\b/i.test(value)) {
      depth -= 1;

      if (depth === 0) {
        return { start: token.index, end: tokens.lastIndex };
      }
    } else {
      depth += 1;
    }
  }

  return null;
}

function extractBlocks(html: string): Array<{ tag: string; text: string }> {
  const blocks: Array<{ tag: string; text: string }> = [];
  const re = /<(h[1-6]|p|li|blockquote|pre|figcaption|div)[^>]*>([\s\S]*?)<\/\1\s*>/gi;

  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();

    if (tag === 'div') {
      const openEnd = m.index + m[0].indexOf('>') + 1;
      const close = findMatchingDivClose(html, openEnd);

      if (close) {
        const inner = html.slice(openEnd, close.start);

        if (BLOCK_OPEN_RE.test(inner)) {
          appendDivContainer(blocks, inner);
        } else {
          const text = stripTags(inner);
          if (text.length >= 1) blocks.push({ tag, text });
        }

        // Skip the complete balanced container, not just its first child close.
        re.lastIndex = close.end;
        continue;
      }
    }

    // Preserve the previous fallback for malformed or unclosed containers.
    if (tag === 'div' && BLOCK_OPEN_RE.test(m[2])) {
      appendDivContainer(blocks, m[2]);
      continue;
    }

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
  const cleaned = removeNonContent(html);
  const blocks = extractBlocks(cleaned);
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
    const text = stripTags(cleaned).slice(0, 20000) || 'Empty document.';
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
