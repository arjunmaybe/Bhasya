import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb, seedDev, LocalStorageAdapter, type DbClient } from '@bhasya/db';
import { DevGroundedAdapter, ModelRouter } from '@bhasya/ai';
import type { Services } from '../apps/api/src/services.js';

export const SAMPLE_HTML = `<!doctype html><html><head><title>The Craft of Reading</title></head><body>
<h1>The Craft of Reading</h1>
<h2>Attention</h2>
<p>Attention is the rarest and purest form of generosity. To attend fully to a passage is to give it time.</p>
<p>Distraction, by contrast, fractures the mind into small tradable pieces.</p>
<h2>Memory</h2>
<p>Memory keeps what attention touches. Readers who annotate remember more than readers who skim.</p>
</body></html>`;

export function mockFetch(html = SAMPLE_HTML, contentType = 'text/html'): typeof fetch {
  return (async (_url: unknown) => new Response(html, {
    status: 200, headers: { 'content-type': contentType },
  })) as unknown as typeof fetch;
}

export const publicDns = async (_h: string): Promise<string[]> => ['93.184.216.34'];

export async function makeServices(html = SAMPLE_HTML): Promise<{ svc: Services; identity: { userId: string; workspaceId: string; email: string }; cleanup: () => Promise<void> }> {
  const db = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  const seed = await seedDev(db);
  const identity = { ...seed, email: 'dev@bhasya.local' };
  const storage = new LocalStorageAdapter(join(mkdtempSync(join(tmpdir(), 'bhasya-obj-'))));
  const router = new ModelRouter(new DevGroundedAdapter());
  const svc: Services = { db, storage, router, fetchFn: mockFetch(html) };
  return {
    svc, identity,
    cleanup: async () => { await db.close?.(); },
  };
}

export async function ingestSample(svc: Services, identity: { userId: string; workspaceId: string; email: string }) {
  const { ingestSource } = await import('../apps/api/src/services.js');
  return ingestSource(svc, identity, 'https://example.com/craft-of-reading', { dnsResolve: publicDns });
}
