/**
 * Reading-session PDF export — renderer (pdf-lib, server-side only).
 *
 * Consumes an ExportIR (see export-ir.ts) and produces PDF bytes. Two
 * stages keep the tricky part testable without parsing binary PDFs:
 *
 * - layoutExportIR(ir, measure): PURE text layout. Word-wraps every string,
 *   assigns pages, inserts the hard break before the appendix. No pdf-lib.
 * - renderExportPdf(ir): embeds StandardFonts (no font files needed),
 *   measures with real glyph widths, draws the layout ops, adds footers.
 *
 * Standard PDF fonts only cover WinAnsi, so all text is sanitized to a safe
 * subset first — the renderer never throws on real-world Unicode content.
 * No HTML, no browser, no network, no images (out of scope for this MVP).
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { ExportIR } from './export-ir.js';

export const EXPORT_PDF_PAGE_WIDTH = 595.28;
export const EXPORT_PDF_PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 64;
const CONTENT_WIDTH = EXPORT_PDF_PAGE_WIDTH - MARGIN_X * 2;

export type PdfFontKind = 'regular' | 'bold' | 'italic' | 'mono';
export type TextMeasurer = (text: string, size: number, font: PdfFontKind) => number;

export interface PdfTextOp {
  page: number;
  text: string;
  x: number;
  y: number;
  size: number;
  font: PdfFontKind;
  /** Structural marker for tests (e.g. 'cover-title', 'appendix-divider'). */
  marker?: string;
}

export interface PdfLayout {
  pages: number;
  ops: PdfTextOp[];
}

const LEADING: Record<number, number> = {};

function leading(size: number): number {
  if (!LEADING[size]) LEADING[size] = Math.round(size * 1.35 * 10) / 10;
  return LEADING[size];
}


/** Unicode characters mapped to readable ASCII equivalents. */
const UNICODE_MAP: Record<string, string> = {
  // Punctuation
  '—': '--',
  '–': '-',
  '―': '--',
  '‐': '-',
  '‑': '-',
  '−': '-',
  '’': "'",
  '‘': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '„': '"',
  '•': '-',
  '…': '...',
  '·': ' - ',
  '′': "'",
  '″': '"',

  // Arrows
  '→': '->',
  '←': '<-',
  '↩': '<-',
  '↪': '->',
  '⇒': '=>',
  '⇐': '<=',
  '⇔': '<=>',
  '↑': '^',
  '↓': 'v',
  '↔': '<->',

  // Mathematical symbols
  '§': 'S. ',
  '±': '+/-',
  '×': 'x',
  '÷': '/',
  '°': 'deg ',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '≈': '~',
  '∞': 'infinity',
  '√': 'sqrt',
  '∑': 'sum',
  '∫': 'integral',

  // Fractions
  '¼': '1/4',
  '½': '1/2',
  '¾': '3/4',
  '⅐': '1/7',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⅓': '1/3',
  '⅔': '2/3',

  // Currency
  '£': 'GBP ',
  '€': 'EUR ',
  '¥': 'JPY ',
  '₹': 'INR ',
  '¢': 'cents ',

  // Greek letters
  'α': 'alpha',
  'β': 'beta',
  'γ': 'gamma',
  'δ': 'delta',
  'ε': 'epsilon',
  'θ': 'theta',
  'λ': 'lambda',
  'μ': 'mu',
  'ν': 'nu',
  'π': 'pi',
  'ρ': 'rho',
  'σ': 'sigma',
  'τ': 'tau',
  'φ': 'phi',
  'ω': 'omega',
  'Δ': 'Delta',
  'Σ': 'Sigma',
  'Ω': 'Omega',

  // Superscripts and subscripts
  '²': '^2',
  '³': '^3',
  '⁴': '^4',
  '⁵': '^5',
  '⁶': '^6',
  '⁷': '^7',
  '⁸': '^8',
  '⁹': '^9',
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',

  // Other symbols
  '⌘': 'Cmd',
  '©': '(c)',
  '®': '(R)',
  '™': '(TM)',
  'µ': 'micro',

  // Latin letters without direct ASCII equivalents
  'æ': 'ae',
  'Æ': 'AE',
  'œ': 'oe',
  'Œ': 'OE',
  'ß': 'ss',
  'ø': 'o',
  'Ø': 'O',
  'ł': 'l',
  'Ł': 'L',
  'đ': 'd',
  'Đ': 'D',
};

/**
 * Converts Unicode text into readable ASCII.
 *
 * Explicit mappings handle symbols, fractions and Greek letters.
 * NFKD normalization handles accented Latin characters.
 * Unsupported symbols fall back to '?'.
 */
export function toSafePdfText(text: string): string {
  let out = '';

  for (const ch of text) {
    if (ch >= ' ' && ch <= '~') {
      out += ch;
      continue;
    }

    if (UNICODE_MAP[ch] !== undefined) {
      out += UNICODE_MAP[ch];
      continue;
    }

    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ' ';
      continue;
    }

    // Decompose accented characters, e.g. é -> e + combining accent.
    const decomposed = ch.normalize('NFKD').replace(/\p{M}/gu, '');

    if (decomposed === '') continue;

    if (/^[\x20-\x7E]+$/.test(decomposed)) {
      out += decomposed;
    } else {
      out += '?';
    }
  }

  return out.replace(/[ ]{2,}/g, ' ');
}


/** Greedy word wrap; overlong tokens are hard-split so nothing overflows. */
export function wrapPdfText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const safe = toSafePdfText(text).trim();
  if (safe.length === 0) return [];
  const lines: string[] = [];
  for (const paragraph of safe.split(/  +/)) {
    const words = paragraph.split(' ').filter((w) => w.length > 0);
    let line = '';
    const push = () => {
      if (line.length > 0) lines.push(line);
      line = '';
    };
    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.length > 0) {
        push();
        if (measure(word) <= maxWidth) {
          line = word;
          continue;
        }
      }
      // Overlong token: hard-split by measured width.
      let chunk = '';
      for (const ch of word) {
        if (measure(chunk + ch) <= maxWidth || chunk.length === 0) chunk += ch;
        else {
          lines.push(chunk);
          chunk = ch;
        }
      }
      line = chunk;
    }
    push();
  }
  return lines;
}

interface LayoutCursor {
  page: number;
  y: number;
  ops: PdfTextOp[];
}

function newPage(cursor: LayoutCursor): void {
  cursor.page += 1;
  cursor.y = EXPORT_PDF_PAGE_HEIGHT - MARGIN_TOP;
}

function ensureSpace(cursor: LayoutCursor, needed: number): void {
  if (cursor.y - needed < MARGIN_BOTTOM) newPage(cursor);
}

/**
 * Keep a heading with the start of its body: require room for the heading
 * plus two body lines before drawing it, so headings never strand alone at
 * a page bottom.
 */
function ensureHeadingBlock(cursor: LayoutCursor, headSize: number, bodySize: number): void {
  ensureSpace(cursor, 4 + leading(headSize) + 6 + 2 * leading(bodySize));
}

function drawLines(
  cursor: LayoutCursor,
  lines: string[],
  opts: { size: number; font: PdfFontKind; x?: number; marker?: string; gapAfter?: number },
): void {
  for (const text of lines) {
    const step = leading(opts.size);
    ensureSpace(cursor, step);
    cursor.ops.push({
      page: cursor.page,
      text,
      x: opts.x ?? MARGIN_X,
      y: cursor.y - step,
      size: opts.size,
      font: opts.font,
      marker: opts.marker,
    });
    cursor.y -= step;
  }
  cursor.y -= opts.gapAfter ?? 4;
}

function drawWrapped(
  cursor: LayoutCursor,
  text: string,
  measure: TextMeasurer,
  opts: { size: number; font: PdfFontKind; x?: number; width?: number; marker?: string; gapAfter?: number },
): void {
  const width = (opts.width ?? CONTENT_WIDTH) - ((opts.x ?? MARGIN_X) - MARGIN_X);
  const lines = wrapPdfText(text, width, (s) => measure(s, opts.size, opts.font));
  if (lines.length === 0) return;

  // Keep a paragraph or other short text block together when it fits
  // on a fresh page. Long blocks may still split across pages.
  const blockHeight = lines.length * leading(opts.size) + (opts.gapAfter ?? 4);
  const freshPageCapacity = EXPORT_PDF_PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

  if (
    blockHeight <= freshPageCapacity &&
    cursor.y - blockHeight < MARGIN_BOTTOM
  ) {
    newPage(cursor);
  }

  drawLines(cursor, lines, opts);
}

/**
 * Pure layout: ExportIR + width measurer → ordered text ops with page
 * numbers. Deterministic for a given measurer, so tests assert structure
 * (ordering, page-break boundary, markers, truncation notices) here.
 */
export function layoutExportIR(ir: ExportIR, measure: TextMeasurer): PdfLayout {
  const cursor: LayoutCursor = { page: 0, y: 0, ops: [] };
  newPage(cursor);
  const doc = ir.document;

  drawWrapped(cursor, doc.title, measure, { size: 22, font: 'bold', marker: 'cover-title', gapAfter: 8 });
  if (doc.sourceUrl.length > 0) {
    drawWrapped(cursor, doc.sourceUrl, measure, { size: 10, font: 'regular', marker: 'cover-source', gapAfter: 8 });
  }
  const meta: Array<[string, string]> = [
    ['Version', String(doc.versionNo)],
    ['Imported', doc.importedAt],
    ['Passages', String(doc.passageCount)],
    ['Threads', String(ir.totals.threadCount)],
    ['Questions & answers', String(ir.totals.messageCount)],
    // Provenance lives on the cover: a separate post-article Source block
    // could land alone on a page tail and produce a near-blank page.
    ['Content hash', doc.contentHash.slice(0, 12)],
    ['Generated', ir.generatedAt],
  ];
  for (const [k, v] of meta) {
    if (v.length === 0) continue;
    drawWrapped(cursor, `${k}: ${v}`, measure, { size: 10, font: 'regular', gapAfter: 1 });
  }
  cursor.y -= 6;

  // Contents: article headings, then one line per thread.
  drawWrapped(cursor, 'In this export', measure, { size: 13, font: 'bold', marker: 'cover-contents', gapAfter: 4 });
  const headings = ir.nodes.filter((n) => n.kind === 'heading').slice(0, 20);
  for (const h of headings) {
    drawWrapped(cursor, h.text, measure, { size: 10, font: 'regular', x: MARGIN_X + 14, gapAfter: 1 });
  }
  for (const t of ir.threads) {
    const excerpt = t.anchorExcerpt.length > 80 ? `${t.anchorExcerpt.slice(0, 80)}…` : t.anchorExcerpt;
    drawWrapped(cursor, `${t.position}. ${excerpt}`, measure, { size: 10, font: 'regular', x: MARGIN_X + 14, gapAfter: 1 });
  }
  if (ir.threads.length === 0) {
    drawWrapped(cursor, 'No explanations yet for this document.', measure, {
      size: 10, font: 'italic', x: MARGIN_X + 14, marker: 'cover-no-threads', gapAfter: 1,
    });
  }

  // ── Part 1: article ──
  ensureHeadingBlock(cursor, 16, 11);
  drawWrapped(cursor, 'Article', measure, { size: 16, font: 'bold', marker: 'article-heading', gapAfter: 6 });
  if (ir.nodes.length === 0) {
    drawWrapped(cursor, 'No readable text preserved for this version.', measure, {
      size: 11, font: 'italic', gapAfter: 4,
    });
  }
let inFootnotesSection = false;
let footnoteNumber = 0;
for (const n of ir.nodes) {
  switch (n.kind) {
    case 'heading':
      inFootnotesSection = n.text.trim().toLowerCase() === 'footnotes';

      if (inFootnotesSection) {
        footnoteNumber = 0;
      }

      ensureHeadingBlock(cursor, 14, 11);
      drawWrapped(cursor, n.text, measure, {
        size: 14,
        font: 'bold',
        gapAfter: 5,
      });
      break;

    case 'list_item':
      if (inFootnotesSection) {
        footnoteNumber += 1;

        drawWrapped(cursor, `${footnoteNumber}. ${n.text}`, measure, {
          size: 11,
          font: 'regular',
          x: MARGIN_X + 18,
          width: CONTENT_WIDTH - 18,
          gapAfter: 3,
        });
      } else {
        drawWrapped(cursor, `- ${n.text}`, measure, {
          size: 11,
          font: 'regular',
          x: MARGIN_X + 18,
          width: CONTENT_WIDTH - 18,
          gapAfter: 3,
        });
      }
      break;

    case 'quote':
      drawWrapped(cursor, n.text, measure, {
        size: 10.5,
        font: 'italic',
        x: MARGIN_X + 18,
        width: CONTENT_WIDTH - 18,
        gapAfter: 5,
      });
      break;

    case 'code':
      drawWrapped(cursor, n.text, measure, {
        size: 9.5,
        font: 'mono',
        x: MARGIN_X + 18,
        width: CONTENT_WIDTH - 18,
        gapAfter: 5,
      });
      break;

    case 'caption':
      drawWrapped(cursor, n.text, measure, {
        size: 10,
        font: 'italic',
        gapAfter: 5,
        marker: 'caption',
      });
      break;

    default:
      drawWrapped(cursor, n.text, measure, {
        size: 11,
        font: 'regular',
        gapAfter: 5,
      });
      break;
  }
}

  if (ir.truncation.passagesOmitted > 0) {
    drawWrapped(cursor, `[Article truncated: showing first ${ir.nodes.length} blocks, ${ir.truncation.passagesOmitted} further passages omitted.]`, measure, {
      size: 10, font: 'italic', marker: 'article-truncated', gapAfter: 4,
    });
  }
  if (ir.mediaNote) {
    drawWrapped(cursor, ir.mediaNote, measure, { size: 10, font: 'italic', marker: 'media-note', gapAfter: 4 });
  }

  // ── Part 2: appendix on a fresh page (hard break) ──
  // Provenance (source URL, version, content hash) is consolidated on the
  // cover above, so there is no trailing Source block that could land alone
  // on a page tail and create a near-blank page before the appendix.
  // Skip the break when the article already ended at a fresh page top;
  // otherwise the divider strands alone on a near-empty page of its own.
  if (cursor.ops.some((o) => o.page === cursor.page)) newPage(cursor);
  // Keep the divider with the first appendix content: reserve divider +
  // subtitle + first thread title as one block, so a page tail holding only
  // the divider can never strand it away from its threads.
  const dividerTitle = 'Bhasya Reading Session';
  const dividerSub =
    'Explanations and follow-ups for this document, each anchored to the passage it explains.';
  const firstTitle =
    ir.threads.length > 0 ? `${ir.threads[0].position}. ${ir.threads[0].anchorExcerpt}` : null;
  const dividerNeed =
    wrapPdfText(dividerTitle, CONTENT_WIDTH, (s) => measure(s, 16, 'bold')).length * leading(16) + 4 +
    wrapPdfText(dividerSub, CONTENT_WIDTH, (s) => measure(s, 11, 'italic')).length * leading(11) + 8;
  ensureSpace(
    cursor,
    firstTitle === null
      ? dividerNeed + leading(11) + 4
      : dividerNeed + 4 +
          wrapPdfText(firstTitle, CONTENT_WIDTH, (s) => measure(s, 13, 'bold')).length * leading(13) + 3,
  );
  ensureHeadingBlock(cursor, 16, 11);
  drawWrapped(cursor, 'Bhasya Reading Session', measure, {
    size: 16, font: 'bold', marker: 'appendix-divider', gapAfter: 4,
  });
  drawWrapped(cursor, 'Explanations and follow-ups for this document, each anchored to the passage it explains.', measure, {
    size: 11, font: 'italic', gapAfter: 8,
  });
  if (ir.threads.length === 0) {
    drawWrapped(cursor, 'No explanations yet for this document.', measure, {
      size: 11, font: 'regular', marker: 'appendix-empty', gapAfter: 4,
    });
  }
  for (const t of ir.threads) {
    ensureHeadingBlock(cursor, 13, 11);
    drawWrapped(cursor, `${t.position}. ${t.anchorExcerpt}`, measure, {
      size: 13, font: 'bold', marker: `thread-${t.position}`, gapAfter: 3,
    });
    // Human-readable location; internal structural paths stay out of output.
    const where = t.location ?? '';
    if (where.length > 0) {
      drawWrapped(cursor, where, measure, { size: 10, font: 'italic', marker: `thread-${t.position}-location`, gapAfter: 4 });
    }
    if (t.messages.length === 0) {
      drawWrapped(cursor, '[No persisted messages for this thread.]', measure, { size: 10, font: 'italic', gapAfter: 4 });
    }
    for (const m of t.messages) {
      const label = m.role === 'user' ? 'Question' : 'Bhasya';
      drawWrapped(cursor, label, measure, { size: 10, font: 'bold', gapAfter: 1 });
      // over-long content already carries its '[truncated]' marker from IR.
      drawWrapped(cursor, m.content, measure, { size: 11, font: 'regular', gapAfter: 4 });
    }
    for (const e of t.evidence) {
      const scope = e.scopeLevel === 'L0' ? 'exact passage' : 'related passage';
      drawWrapped(cursor, `Evidence (${scope})`, measure, { size: 10, font: 'bold', gapAfter: 1 });
      drawWrapped(cursor, e.quote, measure, {
        size: 10.5, font: 'italic', x: MARGIN_X + 18, width: CONTENT_WIDTH - 18, gapAfter: 4,
      });
    }
    // Per-thread citation labels are not repeated here: the consolidated
    // citation index below carries every label with its thread reference.
    // Evidence quotes stay in place; they appear nowhere else.
  }
  if (ir.truncation.threadsOmitted > 0 || ir.truncation.messagesOmitted > 0 || ir.truncation.charsTruncated > 0) {
    const parts: string[] = [];
    if (ir.truncation.threadsOmitted > 0) parts.push(`${ir.truncation.threadsOmitted} further threads omitted`);
    if (ir.truncation.messagesOmitted > 0) parts.push(`${ir.truncation.messagesOmitted} further messages omitted`);
    if (ir.truncation.charsTruncated > 0) parts.push(`${ir.truncation.charsTruncated} characters truncated`);
    drawWrapped(cursor, `[Reading session truncated: ${parts.join('; ')}.]`, measure, {
      size: 10, font: 'italic', marker: 'session-truncated', gapAfter: 4,
    });
  }

  // Citation index references thread sections (stable without page math).
  // Labels only: structural paths stay out of reader-facing output.
  const allCites = ir.threads.flatMap((t) =>
    t.citations.map((c) => ({ thread: t.position, label: c.label })),
  );
  if (allCites.length > 0) {
    cursor.y -= 4;
    ensureHeadingBlock(cursor, 13, 10);
    drawWrapped(cursor, 'Evidence and citations', measure, {
      size: 13, font: 'bold', marker: 'citation-index', gapAfter: 4,
    });
    allCites.forEach((c, i) => {
      drawWrapped(cursor, `[${i + 1}] ${c.label} (thread ${c.thread})`, measure, {
        size: 10, font: 'regular', gapAfter: 1,
      });
    });
  }

  return { pages: cursor.page, ops: cursor.ops };
}

const FONT_BY_KIND = {
  regular: StandardFonts.TimesRoman,
  bold: StandardFonts.TimesRomanBold,
  italic: StandardFonts.TimesRomanItalic,
  mono: StandardFonts.Courier,
};

/**
 * Render an ExportIR to PDF bytes. Throws on pdf-lib failure — the caller
 * (export service) must persist nothing in that case (no row, no artifact).
 */
export async function renderExportPdf(ir: ExportIR): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(toSafePdfText(ir.document.title).slice(0, 200));
  pdf.setSubject('Bhasya reading session export');
  const fonts = new Map<PdfFontKind, PDFFont>();
  const getFont = async (kind: PdfFontKind): Promise<PDFFont> => {
    const hit = fonts.get(kind);
    if (hit) return hit;
    const embedded = await pdf.embedFont(FONT_BY_KIND[kind]);
    fonts.set(kind, embedded);
    return embedded;
  };
  // Warm the cache so layout measures with real glyph widths.
  for (const kind of ['regular', 'bold', 'italic', 'mono'] as const) await getFont(kind);
  const measure: TextMeasurer = (text, size, font) => {
    const f = fonts.get(font);
    if (!f) return text.length * size * 0.5;
    return f.widthOfTextAtSize(toSafePdfText(text), size);
  };
  const layout = layoutExportIR(ir, measure);
  const pages = new Map<number, ReturnType<typeof pdf.addPage>>();
  const getPage = (n: number) => {
    let p = pages.get(n);
    if (!p) {
      p = pdf.addPage([EXPORT_PDF_PAGE_WIDTH, EXPORT_PDF_PAGE_HEIGHT]);
      pages.set(n, p);
    }
    return p;
  };
  for (const op of layout.ops) {
    const page = getPage(op.page);
    page.drawText(op.text, {
      x: op.x,
      y: op.y,
      size: op.size,
      font: await getFont(op.font),
      color: rgb(0.1, 0.1, 0.1),
    });
  }
  for (let n = 1; n <= layout.pages; n += 1) {
    const page = getPage(n);
    const footer = await getFont('regular');
    page.drawText(`Page ${n} of ${layout.pages}`, {
      x: MARGIN_X,
      y: 32,
      size: 9,
      font: footer,
      color: rgb(0.44, 0.42, 0.37),
    });
  }
  return pdf.save();
}
