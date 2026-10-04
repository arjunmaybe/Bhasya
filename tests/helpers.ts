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

/**
 * Every key ModelRouter.fromEnv consults. Tests asserting default selection
 * must scrub these so they stay deterministic regardless of the shell that
 * runs vitest (e.g. a benchmark shell exporting provider keys). Restored
 * afterwards; same save/restore pattern as the auth/storage tests.
 */
export const PROVIDER_ENV_KEYS = [
  'BHASYA_PROVIDER',
  'BHASYA_MODEL_API_KEY', 'BHASYA_MODEL_ID', 'BHASYA_MODEL_ENDPOINT',
  'BHASYA_MODEL_MAX_TOKENS', 'BHASYA_MODEL_REASONING_EFFORT', 'BHASYA_MODEL_INCLUDE_REASONING',
  'BHASYA_MODEL_PROVIDER_SORT', 'BHASYA_MODEL_ALLOW_FALLBACKS',
  'GEMINI_API_KEY', 'GEMINI_MODEL_ID', 'GEMINI_MAX_TOKENS', 'GEMINI_THINKING_LEVEL', 'GEMINI_API_ENDPOINT',
  'GROQ_API_KEY', 'GROQ_MODEL_ID', 'GROQ_MAX_TOKENS', 'GROQ_REASONING_EFFORT', 'GROQ_API_ENDPOINT',
];

/** Removes provider/model keys from process.env; returns a restore function. */
export function scrubProviderEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of PROVIDER_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of PROVIDER_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
