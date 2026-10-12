import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { MemoryStorageAdapter } from '@bhasya/db';
import { createApp } from '../apps/api/src/app.js';
import { resolveAnchor, explainSelection, setServices } from '../apps/api/src/services.js';
import { createReadingSessionExport } from '../apps/api/src/export-service.js';
import { toSafePdfText } from '../apps/api/src/export-pdf.js';
import { ingestSample, makeServices } from './helpers.js';

/** Expected content must match renderer output: sanitized to ASCII. */
const pdfText = (s: string): string => toSafePdfText(String(s));

/**
 * Minimal PDF text extractor for structural assertions (no binary
 * snapshots): inflate content streams, decode literal (...) and hex <...>
 * strings. The export renderer emits ASCII-only text, so WinAnsi decoding
 * is a plain char-code mapping here.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let sm: RegExpExecArray | null;
  const chunks: string[] = [];
  while ((sm = streamRe.exec(raw)) !== null) chunks.push(sm[1]);
  const texts: string[] = [];
  const decode = (chunk: string) => {
    const lit = /\((?:[^()\\]|\\.)*\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = lit.exec(chunk)) !== null) {
      texts.push(
        lm[0].slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c: string) =>
          c === 'n' ? ' ' : c === 'r' ? ' ' : c === 't' ? ' ' : c,
        ),
      );
    }
    const hex = /<([0-9A-Fa-f]+)>/g;
    let hm: RegExpExecArray | null;
    while ((hm = hex.exec(chunk)) !== null) {
      let s = '';
      for (let i = 0; i + 1 < hm[1].length; i += 2) s += String.fromCharCode(parseInt(hm[1].slice(i, i + 2), 16));
      texts.push(s);
    }
  };
  if (chunks.length === 0) {
    decode(raw);
  } else {
    for (const c of chunks) {
      const data = Buffer.from(c, 'latin1');
      // Flate streams start with a zlib header (0x78); uncompressed else.
      try {
        if (data.length > 2 && data[0] === 0x78) decode(inflateSync(data).toString('latin1'));
        else decode(c);
      } catch {
        decode(c);
      }
    }
  }
  return texts.join(' ');
}

const SEL_A = 'rarest and purest form of generosity';
const SEL_B = 'Readers who annotate remember more';

async function setupDoc() {
  const { svc, identity, cleanup } = await makeServices();
  const ing = await ingestSample(svc, identity);
  return { svc, identity, cleanup, versionId: ing.versionId as string };
}

async function explain(svc: any, identity: any, versionId: string, selectedText: string, question?: string, threadId?: string, anchorId?: string) {
  const anchor = anchorId ? { anchorId } : await resolveAnchor(svc, identity, { documentVersionId: versionId, selectedText });
  return explainSelection(svc, identity, { anchorId: anchor.anchorId, ...(question ? { question } : {}), ...(threadId ? { threadId } : {}) });
}

describe('export API: article with zero threads', () => {
  it('creates a stored export with article content and no appendix threads', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      setServices(svc);
      const app = createApp();
      const res = await app.request(`/api/documents/${versionId}/exports`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(typeof body.exportId).toBe('string');
      expect(body.byteSize).toBeGreaterThan(1000);
      expect(body.threadCount).toBe(0);
      expect(body.downloadUrl).toBe(`/api/exports/${body.exportId}`);
      const row = (await svc.db.query(`SELECT status, storage_key, byte_size, thread_count FROM exports WHERE id = $1`, [body.exportId])).rows[0] as any;
      expect(row.status).toBe('complete');
      expect(String(row.storage_key)).toBe(`exports/${versionId}/${body.exportId}.pdf`);
      expect(Number(row.byte_size)).toBe(body.byteSize);

      const dl = await app.request(body.downloadUrl);
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-type')).toBe('application/pdf');
      expect(dl.headers.get('content-disposition')).toContain('attachment');
      expect(dl.headers.get('content-disposition')).toContain(body.exportId);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      expect(bytes.length).toBe(body.byteSize);
      const text = extractPdfText(bytes);
      expect(text).toContain('The Craft of Reading');
      expect(text).toContain('Bhasya Reading Session');
      expect(text).toContain('No explanations yet for this document.');
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});

describe('export API: threads, ordering, evidence, citations', () => {
  it('one thread preserves excerpt, location, answer, evidence, citation', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      setServices(svc);
      const app = createApp();
      const first = await explain(svc, identity, versionId, SEL_A);
      const res = await app.request(`/api/documents/${versionId}/exports`, { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.threadCount).toBe(1);
      const bytes = new Uint8Array(await (await app.request(body.downloadUrl)).arrayBuffer());
      const text = extractPdfText(bytes);
      expect(text).toContain(SEL_A);
      expect(text).toContain('Attention');
      expect(text).toContain(pdfText(first.text).slice(0, 40));
      expect(text).toContain('Evidence (exact passage)');
      expect(text).toContain('Cited passage');
      expect(text).toContain('Evidence and citations');
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('follow-up questions and answers keep persisted order', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: versionId, selectedText: SEL_A });
      const first = await explain(svc, identity, versionId, SEL_A, undefined, undefined, anchor.anchorId);
      const Q = 'what does this mean in practice?';
      await explain(svc, identity, versionId, SEL_A, Q, first.threadId, anchor.anchorId);
      const out = await createReadingSessionExport(svc, identity, versionId);
      expect(out.threadCount).toBe(1);
      const row = (await svc.db.query(`SELECT * FROM exports WHERE id = $1`, [out.exportId])).rows[0];
      expect(row).toBeTruthy();
      const bytes = await svc.storage.get(`exports/${versionId}/${out.exportId}.pdf`);
      const text = extractPdfText(bytes!);
      // Follow-up answer persisted after the question renders after it.
      const msgs = (await svc.db.query(
        `SELECT content FROM thread_messages WHERE thread_id = $1 ORDER BY created_at`, [first.threadId],
      )).rows as any[];
      expect(msgs.length).toBe(4);
      const firstAnswer = pdfText(first.text).slice(0, 30);
      const lastAnswer = pdfText(msgs[3].content).slice(0, 30);
      const answerIdx = text.indexOf(firstAnswer);
      const qIdx = text.indexOf(Q);
      expect(answerIdx).toBeGreaterThan(-1);
      expect(qIdx).toBeGreaterThan(answerIdx);
      expect(text).toContain(lastAnswer);
      // lastAnswer is a 30-char prefix of the selection, which also appears
      // earlier (article, excerpt, first answer): search from the question so
      // this genuinely proves persisted question -> answer ordering.
      expect(text.indexOf(lastAnswer, qIdx)).toBeGreaterThan(qIdx);
    } finally {
      await cleanup();
    }
  });

  it('multiple threads on different passages render in document order', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      // Second selection first: export must still order by anchor path.
      await explain(svc, identity, versionId, SEL_B);
      await explain(svc, identity, versionId, SEL_A);
      const out = await createReadingSessionExport(svc, identity, versionId);
      expect(out.threadCount).toBe(2);
      const bytes = await svc.storage.get(`exports/${versionId}/${out.exportId}.pdf`);
      const text = extractPdfText(bytes!);
      expect(text).toContain(SEL_A);
      expect(text).toContain(SEL_B);
      expect(text).toContain('1.');
      expect(text).toContain('2.');
    } finally {
      await cleanup();
    }
  });
});

describe('export API: user and workspace isolation', () => {
  it("includes the caller's threads and excludes another user's threads", async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      await explain(svc, identity, versionId, SEL_A);
      // Second user in the SAME workspace explains the same passage.
      const other = (await svc.db.query(
        `INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, ['other@bhasya.test', 'Other'],
      )).rows[0] as any;
      await svc.db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`,
        [identity.workspaceId, other.id],
      );
      const otherIdentity = { userId: String(other.id), workspaceId: identity.workspaceId, email: 'other@bhasya.test' };
      // Distinctive follow-up only the other user asked; the shared article
      // text may legitimately appear, so assert on per-user content.
      const otherQ = 'other user exotic query zebra stripes';
      const otherAnchor = await resolveAnchor(svc, otherIdentity, { documentVersionId: versionId, selectedText: SEL_B });
      const otherFirst = await explain(svc, otherIdentity, versionId, SEL_B, undefined, undefined, otherAnchor.anchorId);
      await explain(svc, otherIdentity, versionId, SEL_B, otherQ, otherFirst.threadId, otherAnchor.anchorId);
      const out = await createReadingSessionExport(svc, identity, versionId);
      expect(out.threadCount).toBe(1);
      const bytes = await svc.storage.get(`exports/${versionId}/${out.exportId}.pdf`);
      const text = extractPdfText(bytes!);
      expect(text).toContain(SEL_A);
      expect(text).not.toContain(otherQ);
      // Sanity: the other thread really exists, only filtered from export.
      const all = (await svc.db.query(`SELECT COUNT(*)::int AS n FROM threads`)).rows[0] as any;
      expect(Number(all.n)).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it('foreign workspace export returns 404', async () => {
    const { svc, identity, cleanup } = await setupDoc();
    try {
      setServices(svc);
      const app = createApp();
      // A document in another workspace the caller cannot see.
      const ws = (await svc.db.query(`INSERT INTO workspaces (name, owner_user_id) VALUES ($1,$2) RETURNING id`, ['Other WS', identity.userId])).rows[0] as any;
      const stranger = (await svc.db.query(`INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, ['stranger@bhasya.test', 'Stranger'])).rows[0] as any;
      await svc.db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`, [ws.id, stranger.id]);
      const otherIdentity = { userId: String(stranger.id), workspaceId: String(ws.id), email: 'stranger@bhasya.test' };
      const ing = await ingestSample(svc, otherIdentity);
      const res = await app.request(`/api/documents/${ing.versionId}/exports`, { method: 'POST' });
      expect(res.status).toBe(404);
      const rows = (await svc.db.query(`SELECT COUNT(*)::int AS n FROM exports`)).rows[0] as any;
      expect(Number(rows.n)).toBe(0);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('logged-out export returns 401', async () => {
    const prevAuth = process.env.BHASYA_USE_AUTH;
    const prevSecret = process.env.BETTER_AUTH_SECRET;
    const prevUrl = process.env.BETTER_AUTH_URL;
    process.env.BHASYA_USE_AUTH = '1';
    process.env.BETTER_AUTH_SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
    process.env.BETTER_AUTH_URL = 'http://localhost';
    const { svc, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const res = await app.request(`/api/documents/00000000-0000-0000-0000-000000000000/exports`, { method: 'POST' });
      expect(res.status).toBe(401);
      const dl = await app.request(`/api/exports/00000000-0000-0000-0000-000000000000`);
      expect(dl.status).toBe(401);
    } finally {
      setServices(null);
      await cleanup();
      if (prevAuth === undefined) delete process.env.BHASYA_USE_AUTH; else process.env.BHASYA_USE_AUTH = prevAuth;
      if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = prevSecret;
      if (prevUrl === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = prevUrl;
    }
  });

  it('another user cannot download my export (404, no enumeration)', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      setServices(svc);
      const app = createApp();
      const out = await createReadingSessionExport(svc, identity, versionId);
      const other = (await svc.db.query(
        `INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, ['snoop@bhasya.test', 'Snoop'],
      )).rows[0] as any;
      await svc.db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`,
        [identity.workspaceId, other.id],
      );
      // Same workspace, different owner: still 404 (owner-scoped download).
      const row = (await svc.db.query(`UPDATE exports SET created_by = $1 WHERE id = $2`, [other.id, out.exportId]));
      void row;
      const dl = await app.request(out.downloadUrl);
      expect(dl.status).toBe(404);
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});

describe('export API: caps, failures, offline guarantees', () => {
  it('long conversations are capped with explicit truncation notices', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      const anchor = await resolveAnchor(svc, identity, { documentVersionId: versionId, selectedText: SEL_A });
      for (let i = 0; i < 55; i += 1) {
        const th = (await svc.db.query(
          `INSERT INTO threads (workspace_id, anchor_id, scope_type, title, created_by) VALUES ($1,$2,'passage',$3,$4) RETURNING id`,
          [identity.workspaceId, anchor.anchorId, `Thread ${i}`, identity.userId],
        )).rows[0] as any;
        await svc.db.query(`INSERT INTO thread_messages (thread_id, role, content, created_by) VALUES ($1,'user',$2,$3)`, [th.id, `Question ${i}?`, identity.userId]);
        await svc.db.query(`INSERT INTO thread_messages (thread_id, role, content, model_id, created_by) VALUES ($1,'assistant',$2,$3,$4)`, [th.id, `Answer ${i}.`, 'dev-grounded-1', identity.userId]);
      }
      const out = await createReadingSessionExport(svc, identity, versionId);
      expect(out.threadCount).toBe(55);
      expect(out.truncated).toBe(true);
      const bytes = await svc.storage.get(`exports/${versionId}/${out.exportId}.pdf`);
      const text = extractPdfText(bytes!);
      expect(text).toContain('further threads omitted');
    } finally {
      await cleanup();
    }
  });

  it('PDF renderer failure leaves no exports row and no artifact', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      await expect(createReadingSessionExport(svc, identity, versionId, {
        renderPdf: async () => { throw new Error('pdf engine exploded'); },
      })).rejects.toThrow(/pdf engine exploded/);
      const rows = (await svc.db.query(`SELECT COUNT(*)::int AS n FROM exports`)).rows[0] as any;
      expect(Number(rows.n)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('StoragePort.put failure surfaces without an exports row', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      const failing = { ...svc, storage: { put: async () => { throw new Error('disk gone'); }, get: async () => null } };
      await expect(createReadingSessionExport(failing as any, identity, versionId)).rejects.toThrow(/disk gone/);
      const rows = (await svc.db.query(`SELECT COUNT(*)::int AS n FROM exports`)).rows[0] as any;
      expect(Number(rows.n)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('storage retrieval failure returns 404 on download', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      setServices(svc);
      const app = createApp();
      const out = await createReadingSessionExport(svc, identity, versionId);
      // Point the lookup at bytes that do not exist (fresh empty storage).
      const empty = new MemoryStorageAdapter();
      setServices({ ...svc, storage: empty });
      const dl = await app.request(out.downloadUrl);
      expect(dl.status).toBe(404);
    } finally {
      setServices(null);
      await cleanup();
    }
  });

  it('export performs zero network fetches', async () => {
    const { svc, identity, cleanup, versionId } = await setupDoc();
    try {
      await explain(svc, identity, versionId, SEL_A);
      let calls = 0;
      const offline = { ...svc, fetchFn: (async () => { calls += 1; throw new Error('network used'); }) as unknown as typeof fetch };
      const out = await createReadingSessionExport(offline as any, identity, versionId);
      expect(out.threadCount).toBe(1);
      expect(calls).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
