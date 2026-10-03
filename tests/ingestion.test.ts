import { describe, expect, it } from 'vitest';
import { assertPublicDnsTarget, decodeResponseBytes, secureFetchUrl, validateUrlShape } from '@bhasya/core';
import { ingestSample, makeServices, publicDns } from './helpers.js';
import { reingestSource } from '../apps/api/src/services.js';

describe('ingestion', () => {
  it('rejects malformed URLs, non-http schemes, and private destinations', () => {
    expect(() => validateUrlShape('not a url')).toThrow();
    expect(() => validateUrlShape('ftp://example.com/x')).toThrow(/http\/https/);
    expect(() => validateUrlShape('http://localhost:3000/x')).toThrow(/private/);
    expect(() => validateUrlShape('http://127.0.0.1/x')).toThrow(/private/);
    expect(() => validateUrlShape('http://169.254.10.1/x')).toThrow(/private/);
    expect(() => validateUrlShape('http://10.0.0.5/x')).toThrow(/private/);
    expect(() => validateUrlShape('https://user:pass@example.com/')).toThrow(/credentials/);
  });

  it('rejects private DNS targets', async () => {
    await expect(assertPublicDnsTarget('example.com', async () => ['127.0.0.1'])).rejects.toThrow(/private/);
    await expect(assertPublicDnsTarget('example.com', async () => ['93.184.216.34'])).resolves.toBeUndefined();
  });

  it('ingests a URL into source + immutable version + tree + passages', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const out = await ingestSample(svc, identity);
      expect(out.sourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(out.versionNo).toBe(1);
      expect(out.passageCount).toBeGreaterThanOrEqual(3);
      expect(out.title).toContain('Craft');

      const nodes = await svc.db.query(`SELECT node_type, structural_path, parent_id FROM document_nodes WHERE document_version_id = $1`, [out.versionId]);
      expect(nodes.rows.length).toBeGreaterThanOrEqual(5);
      const paths = nodes.rows.map((r) => String((r as any).structural_path));
      expect(paths).toContain('/doc');
      expect(paths.some((p) => p.startsWith('/doc/sec['))).toBe(true);

      const passages = await svc.db.query(`SELECT id, node_id, structural_path, text, text_hash FROM passages WHERE document_version_id = $1`, [out.versionId]);
      expect(passages.rows.length).toBe(out.passageCount);
      for (const p of passages.rows as any[]) {
        expect(p.text.length).toBeGreaterThan(0);
        expect(p.text_hash).toMatch(/^[0-9a-f]{64}$/);
      }

      const ev = await svc.db.query(`SELECT event_type FROM event_log WHERE event_type='source_imported' AND resource_id=$1`, [out.versionId]);
      expect(ev.rows.length).toBe(1);
    } finally { await cleanup(); }
  });

  it('decodes response bytes by BOM, header charset, meta declaration, then UTF-8', async () => {
    const RSQUO = '’';
    // windows-1252 body declared via HTTP header: 0x92 is RIGHT SINGLE QUOTATION MARK.
    const cp1252 = Buffer.from('Alice\x92s don\x92t', 'latin1');
    expect(decodeResponseBytes(cp1252, 'text/html; charset=windows-1252')).toBe(`Alice${RSQUO}s don${RSQUO}t`);
    // Gutenberg shape: bare `text/html`, UTF-8 declared only via <meta>, UTF-8 bytes.
    const metaUtf8 = Buffer.from(
      '<html><head><meta http-equiv="Content-Type" content="text/html;charset=utf-8" /></head>' +
      `<body>she${RSQUO}s</body></html>`,
      'utf8',
    );
    expect(decodeResponseBytes(metaUtf8, 'text/html')).toContain(`she${RSQUO}s`);
    // No declarations anywhere: UTF-8 default (previous behavior preserved).
    expect(decodeResponseBytes(Buffer.from(`couldn${RSQUO}t`, 'utf8'), 'text/html')).toBe(`couldn${RSQUO}t`);
    // BOM wins over a conflicting header charset.
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')]);
    expect(decodeResponseBytes(bom, 'text/html; charset=windows-1252')).toBe('hi');
  });

  it('secureFetchUrl decodes non-UTF-8 sources instead of mojibake', async () => {
    const RSQUO = '’';
    const cp1252 = Buffer.from(`<html><body><p>Alice\x92s don\x92t</p></body></html>`, 'latin1');
    const fetchCp = (async () =>
      new Response(cp1252, { status: 200, headers: { 'content-type': 'text/html; charset=windows-1252' } })) as unknown as typeof fetch;
    const out = await secureFetchUrl('https://example.com/austen', { fetchFn: fetchCp, dnsResolve: publicDns });
    expect(out.html).toContain(`Alice${RSQUO}s don${RSQUO}t`);
    expect(out.html).not.toContain('â');
    expect(out.html).not.toContain('�');
  });

  it('re-ingestion creates a new immutable version and never mutates v1', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const v1 = await ingestSample(svc, identity);
      const before = await svc.db.query(`SELECT node_count, passage_count FROM document_versions WHERE id=$1`, [v1.versionId]);
      // Different content on re-ingest
      svc.fetchFn = (async () => new Response(
        `<!doctype html><html><head><title>The Craft of Reading</title></head><body><h1>The Craft of Reading</h1><p>Attention is the rarest and purest form of generosity, revised edition with more.</p></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as unknown as typeof fetch;
      const v2 = await reingestSource(svc, identity, v1.sourceId, { dnsResolve: publicDns });
      expect(v2.versionId).not.toBe(v1.versionId);
      expect(v2.versionNo).toBe(2);
      const after = await svc.db.query(`SELECT node_count, passage_count FROM document_versions WHERE id=$1`, [v1.versionId]);
      expect(after.rows[0]).toEqual(before.rows[0]);
      await expect(svc.db.query(`UPDATE document_versions SET title='x' WHERE id=$1`, [v1.versionId])).rejects.toThrow(/immutable/);
    } finally { await cleanup(); }
  });
});
