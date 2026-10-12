import { describe, expect, it } from 'vitest';
import {
  findPassageForSelection,
  locateSelection,
  normalizeHtmlToCanonical,
} from '@bhasya/core';
import { makeServices, publicDns } from './helpers.js';
import { resolveAnchor } from '../apps/api/src/services.js';

/**
 * Fresh-article selection regression: inline markup must not create phantom
 * spaces in canonical text. The browser renders `word1<b>word2</b>` as
 * `word1word2` and `</b>,` with no gap before the comma, so canonical text
 * must do the same — otherwise the exact browser-visible selection string
 * cannot match and anchor resolution fails before any AI generation.
 */

const RICH_HTML = `<!doctype html><html><head><title>Forgetful CPU</title></head><body>
<h1>Forgetful CPU</h1>
<p>The <b>forgetful CPU</b>, needs care.</p>
<p>Plain second paragraph for structure.</p>
</body></html>`;

function passageTexts(html: string): string[] {
  return normalizeHtmlToCanonical(html).passages.map((p) => p.text);
}

describe('inline markup normalization (browser-visible text semantics)', () => {
  it('1. inline markup adjacent to punctuation adds no phantom space', () => {
    const texts = passageTexts(
      `<p>The <b>forgetful CPU</b>, needs care.</p>`,
    );
    expect(texts).toEqual(['The forgetful CPU, needs care.']);
  });

  it('2. inline markup adjacent directly to words concatenates like the browser', () => {
    const texts = passageTexts(`<p>word1<b>word2</b> end.</p>`);
    expect(texts).toEqual(['word1word2 end.']);
    // Links and other inline elements behave the same way.
    expect(passageTexts(`<p>read <a href="https://example.com/x">more</a>here.</p>`)).toEqual([
      'read morehere.',
    ]);
  });

  it('3. multiple adjacent inline tags introduce no spaces', () => {
    expect(passageTexts(`<p><strong>Hello</strong><em>world</em>.</p>`)).toEqual([
      'Helloworld.',
    ]);
  });

  it('4. structural boundaries still separate content', () => {
    expect(passageTexts(`<p>First.</p><p>Second.</p>`)).toEqual(['First.', 'Second.']);
    expect(passageTexts(`<ul><li>One</li><li>Two</li></ul>`)).toEqual(['One', 'Two']);
    expect(passageTexts(`<div>A</div><div>B</div>`)).toEqual(['A', 'B']);
    // A line break inside a block surfaces as whitespace, matching selections.
    expect(passageTexts(`<p>line one<br>line two.</p>`)).toEqual(['line one line two.']);
  });

  it('entity decoding and whitespace collapsing behavior is preserved', () => {
    expect(passageTexts(`<p>Fish &amp; chips &nbsp;here.</p>`)).toEqual([
      'Fish & chips here.',
    ]);
    expect(passageTexts(`<p>  spaced\t\tout\n\nwords.  </p>`)).toEqual([
      'spaced out words.',
    ]);
  });

  it('whitespace-collapsed fallback still matches selections with newlines', () => {
    const passage = 'The forgetful CPU, needs care.';
    const loc = locateSelection(passage, 'forgetful\nCPU,  needs');
    expect(loc).not.toBeNull();
    expect(loc!.start).toBe(4);
  });
});

describe('anchor resolution on inline-markup passages (fresh-article path)', () => {
  it('5. resolves the exact browser-visible selection with correct passage/offsets', async () => {
    const { svc, identity, cleanup } = await makeServices(RICH_HTML);
    try {
      const { ingestSource } = await import('../apps/api/src/services.js');
      const ing = await ingestSource(svc, identity, 'https://example.com/forgetful-cpu', {
        dnsResolve: publicDns,
      });
      const rows = (await svc.db.query(
        `SELECT id, text FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal`,
        [ing.versionId],
      )).rows as any[];
      expect(rows.length).toBe(2);
      expect(String(rows[0].text)).toBe('The forgetful CPU, needs care.');

      // Browser-visible selection string, scoped to the visible passage.
      const selectedText = 'The forgetful CPU, needs care.';
      const out = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId,
        selectedText,
        passageId: String(rows[0].id),
      });
      expect(String(out.passageId)).toBe(String(rows[0].id));
      expect(out.startOffset).toBe(0);
      expect(out.endOffset).toBe(selectedText.length);
      const anchor = (
        await svc.db.query(`SELECT selected_text FROM anchors WHERE id = $1`, [out.anchorId])
      ).rows[0] as any;
      expect(String(anchor.selected_text)).toBe(selectedText);

      // The same selection also resolves without an explicit passage scope.
      const unscoped = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId,
        selectedText: 'forgetful CPU, needs',
      });
      expect(String(unscoped.passageId)).toBe(String(rows[0].id));

      // Pure unit-level proof on the persisted canonical text.
      const found = findPassageForSelection(
        rows.map((r: any) => ({
          id: String(r.id),
          nodeId: 'n',
          structuralPath: '/doc/sec[1]/p[1]',
          text: String(r.text),
        })),
        selectedText,
      );
      expect(found?.passage.id).toBe(String(rows[0].id));
    } finally {
      await cleanup();
    }
  });

  it('6. a genuinely absent selection still fails with the exact error', async () => {
    const { svc, identity, cleanup } = await makeServices(RICH_HTML);
    try {
      const { ingestSource } = await import('../apps/api/src/services.js');
      const ing = await ingestSource(svc, identity, 'https://example.com/forgetful-cpu', {
        dnsResolve: publicDns,
      });
      await expect(
        resolveAnchor(svc, identity, {
          documentVersionId: ing.versionId,
          selectedText: 'zzz no such sentence here',
        }),
      ).rejects.toThrow(/selection not found in document version/);
    } finally {
      await cleanup();
    }
  });
});
