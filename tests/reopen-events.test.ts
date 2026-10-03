import { describe, expect, it } from 'vitest';
import { ingestSample, makeServices } from './helpers.js';
import { explainSelection, resolveAnchor } from '../apps/api/src/services.js';
import { authorize, HttpError } from '../authorization/resource-resolvers.js';
import { createApp } from '../apps/api/src/app.js';
import { setServices } from '../apps/api/src/services.js';

describe('reopen + events + authorization', () => {
  it('thread reloads with prior explanation; citation resolves to the passage; events recorded', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'Distraction, by contrast, fractures the mind',
      });
      const ex = await explainSelection(svc, identity, { anchorId: anchor.anchorId });

      // Simulate process/page reload: new handle to same state via fresh queries.
      const thread = (await svc.db.query(`SELECT * FROM threads WHERE id=$1`, [ex.threadId])).rows[0] as any;
      expect(thread).toBeTruthy();
      const msgs = (await svc.db.query(`SELECT * FROM thread_messages WHERE thread_id=$1 ORDER BY created_at`, [ex.threadId])).rows as any[];
      expect(msgs.length).toBe(2);
      expect(String(msgs[1].content)).toBe(ex.text);

      // Citation resolves back to the exact passage.
      const cite = (await svc.db.query(
        `SELECT ci.id, e.passage_id, p.text FROM citations ci JOIN evidence e ON e.id=ci.evidence_id JOIN passages p ON p.id=e.passage_id WHERE ci.id=$1`,
        [ex.citationIds[0]],
      )).rows[0] as any;
      expect(String(cite.passage_id)).toBe(anchor.passageId);
      expect(String(cite.text)).toContain('Distraction');

      const events = (await svc.db.query(
        `SELECT event_type FROM event_log WHERE workspace_id=$1`, [identity.workspaceId],
      )).rows.map((r: any) => r.event_type);
      for (const e of ['source_imported', 'thread_created', 'passage_highlighted']) {
        expect(events).toContain(e);
      }
    } finally { await cleanup(); }
  });

  it('authorization is enumeration-safe: cross-workspace access reads as 404', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      // Stranger: member of no workspace.
      const stranger = { userId: '00000000-0000-0000-0000-000000000099', workspaceId: '00000000-0000-0000-0000-000000000098', email: 'x@y.z' };
      await expect(authorize(svc.db, stranger, 'document_version', ing.versionId)).rejects.toMatchObject({ status: 404 });
      await expect(authorize(svc.db, null, 'document_version', ing.versionId)).rejects.toBeInstanceOf(HttpError);
    } finally { await cleanup(); }
  });

  it('HTTP reopen flow works end to end (thread GET + citation resolve)', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const call = async (path: string, init?: RequestInit) =>
        app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });

      // Seed identity is automatic (dev); ingest via HTTP with mocked fetch at service layer.
      const ing = await ingestSample(svc, identity);
      const anchor = await resolveAnchor(svc, identity, {
        documentVersionId: ing.versionId, selectedText: 'To attend fully to a passage is to give it time',
      });
      const ex = await explainSelection(svc, identity, { anchorId: anchor.anchorId });

      const t = await call(`/api/threads/${ex.threadId}`);
      expect(t.status).toBe(200);
      const tj = (await t.json()) as any;
      expect(tj.messages.length).toBe(2);
      expect(tj.citations.length).toBeGreaterThanOrEqual(1);

      const c = await call(`/api/citations/${ex.citationIds[0]}`);
      expect(c.status).toBe(200);
      const cj = (await c.json()) as any;
      expect(String(cj.citation.passage_id)).toBe(anchor.passageId);
    } finally {
      setServices(null);
      await cleanup();
    }
  });
});
