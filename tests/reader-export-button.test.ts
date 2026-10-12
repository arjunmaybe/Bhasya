import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8');
const api = () =>
  readFileSync(join(process.cwd(), 'apps/web/lib/api.ts'), 'utf8');
const css = () =>
  readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');
const webSrc = () =>
  readFileSync(join(process.cwd(), 'apps/web/components/ReaderClient.tsx'), 'utf8') +
  readFileSync(join(process.cwd(), 'apps/web/lib/api.ts'), 'utf8');

describe('reader export button: secondary server-side PDF action', () => {
  it('offers a clearly labeled Export action in the side panel', () => {
    const s = src();
    expect(s).toMatch(/data-testid="export-pdf-btn"/);
    expect(s).toMatch(/Export PDF/);
    const aside = s.indexOf('<aside className="side"');
    const btn = s.indexOf('data-testid="export-pdf-btn"');
    expect(btn).toBeGreaterThan(aside);
    // Secondary ghost styling, disabled while preparing.
    expect(s).toMatch(/className="export-row"/);
    expect(css()).toMatch(/\.export-row\s*\{[^}]*display:\s*flex/);
  });

  it('requests generation server-side and downloads the private artifact', () => {
    const s = src();
    expect(s).toMatch(/\/api\/documents\/\$\{versionId\}\/exports/);
    expect(s).toMatch(/\/api\/exports\/\$\{out\.exportId\}/);
    expect(s).toMatch(/document\.createElement\('a'\)/);
    expect(api()).toMatch(/requestExport/);
    expect(api()).toMatch(/ExportResult/);
  });

  it('performs no PDF work in the browser', () => {
    const w = webSrc();
    expect(w).not.toMatch(/pdf-lib/);
    expect(w).not.toMatch(/jsPDF|PDFDocument|pdfkit/);
    expect(w).not.toMatch(/createObjectURL/);
    expect(w).not.toMatch(/window\.print/);
  });

  it('leaves navigation, streaming, and thread behavior untouched', () => {
    const s = src();
    expect(s).toMatch(/scrollToPassage\(passageId, 'start'\)/);
    expect(s).toMatch(/pendingExplainRef/);
    expect(s).toMatch(/consumeThreadStream/);
    expect(s).toMatch(/data-testid="thread-scroll"/);
  });
});
