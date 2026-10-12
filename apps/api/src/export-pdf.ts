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

/** Common Unicode punctuation mapped to safe ASCII/WinAnsi equivalents. */
const UNICODE_MAP: Record<string, string> = {
  '—': '--', '–': '-', '―': '--', '’': "'", '‘': "'", '‚': ',',
  '“': '"', '”': '"', '„': '"', '•': '-', '…': '...', '→': '->',
  '←': '<-', '§': 'S. ', '±': '+/-', '×': 'x', '÷': '/', '°': 'deg ',
  '©': '(c)', '®': '(R)', '™': '(TM)', ' ': ' ',
};

/** Strip anything outside printable ASCII after mapping common punctuation. */
export function toSafePdfText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch >= ' ' && ch <= '~') out += ch;
    else if (UNICODE_MAP[ch] !== undefined) out += UNICODE_MAP[ch];
    else if (ch === '\n' || ch === '\r' || ch === '\t') out += ' ';
    else out += '?';
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
  drawWrapped(cursor, 'Article', measure, { size: 16, font: 'bold', marker: 'article-heading', gapAfter: 6 });
  if (ir.nodes.length === 0) {
    drawWrapped(cursor, 'No readable text preserved for this version.', measure, {
      size: 11, font: 'italic', gapAfter: 4,
    });
  }
  for (const n of ir.nodes) {
    switch (n.kind) {
      case 'heading':
        cursor.y -= 4;
        drawWrapped(cursor, n.text, measure, { size: 14, font: 'bold', gapAfter: 5 });
        break;
      case 'list_item':
        drawWrapped(cursor, `- ${n.text}`, measure, {
          size: 11, font: 'regular', x: MARGIN_X + 18, width: CONTENT_WIDTH - 18, gapAfter: 3,
        });
        break;
      case 'quote':
        drawWrapped(cursor, n.text, measure, {
          size: 10.5, font: 'italic', x: MARGIN_X + 18, width: CONTENT_WIDTH - 18, gapAfter: 5,
        });
        break;
      case 'code':
        drawWrapped(cursor, n.text, measure, {
          size: 9.5, font: 'mono', x: MARGIN_X + 18, width: CONTENT_WIDTH - 18, gapAfter: 5,
        });
        break;
      case 'caption':
        drawWrapped(cursor, n.text, measure, { size: 10, font: 'italic', gapAfter: 5, marker: 'caption' });
        break;
      default:
        drawWrapped(cursor, n.text, measure, { size: 11, font: 'regular', gapAfter: 5 });
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

  drawWrapped(cursor, 'Source', measure, { size: 13, font: 'bold', marker: 'source-heading', gapAfter: 4 });
  if (doc.sourceUrl.length > 0) {
    drawWrapped(cursor, doc.sourceUrl, measure, { size: 10, font: 'regular', gapAfter: 1 });
  }
  drawWrapped(cursor, `Version ${doc.versionNo} · content ${doc.contentHash.slice(0, 12)}`, measure, {
    size: 10, font: 'regular', gapAfter: 1,
  });

  // ── Part 2: appendix on a fresh page (hard break) ──
  newPage(cursor);
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
    cursor.y -= 4;
    drawWrapped(cursor, `${t.position}. ${t.anchorExcerpt}`, measure, {
      size: 13, font: 'bold', marker: `thread-${t.position}`, gapAfter: 3,
    });
    const where = t.sectionLabel ? `From ${t.sectionLabel} · ${t.anchorPath}` : t.anchorPath;
    if (where.length > 0) {
      drawWrapped(cursor, where, measure, { size: 10, font: 'italic', marker: `thread-${t.position}-location`, gapAfter: 4 });
    }
    if (t.messages.length === 0) {
      drawWrapped(cursor, '[No persisted messages for this thread.]', measure, { size: 10, font: 'italic', gapAfter: 4 });
    }
    for (const m of t.messages) {
      const label = m.role === 'user' ? 'Question' : 'Bhasya';
      const suffix = m.role === 'assistant' && m.modelId ? ` · ${m.modelId}` : '';
      drawWrapped(cursor, `${label}${suffix}`, measure, { size: 10, font: 'bold', gapAfter: 1 });
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
    if (t.citations.length > 0) {
      drawWrapped(cursor, `Citations: ${t.citations.map((c) => c.label).join(', ')}`, measure, {
        size: 10, font: 'regular', gapAfter: 4,
      });
    }
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
  const allCites = ir.threads.flatMap((t) =>
    t.citations.map((c) => ({ thread: t.position, label: c.label, path: c.passagePath })),
  );
  if (allCites.length > 0) {
    cursor.y -= 4;
    drawWrapped(cursor, 'Evidence and citations', measure, {
      size: 13, font: 'bold', marker: 'citation-index', gapAfter: 4,
    });
    allCites.forEach((c, i) => {
      const where = c.path.length > 0 ? ` — ${c.path}` : '';
      drawWrapped(cursor, `[${i + 1}] ${c.label} (thread ${c.thread})${where}`, measure, {
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
