/**
 * REAL Supabase Storage smoke test (one-off, live service — NOT a fake).
 *
 * Uses the EXISTING SupabaseStorageAdapter (same StoragePort contract as the
 * app) for put/get, plus a raw Storage REST DELETE for cleanup (the
 * StoragePort contract is put/get only and is NOT changed here).
 *
 * Env only (never committed, never printed):
 *   SUPABASE_URL            e.g. https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY    service_role key (server-side only)
 *   SUPABASE_STORAGE_BUCKET optional, defaults to `bhasya-artifacts`
 *
 * Flow: put temp object → get → verify exact bytes → delete → verify missing.
 * Cleanup runs even on failure. Exits non-zero on any failure.
 *
 * Run:  npx tsx scripts/smoke-supabase-storage.ts
 */
import { SupabaseStorageAdapter } from '@bhasya/db';

const BUCKET_DEFAULT = 'bhasya-artifacts';

function fail(msg: string, code = 1): never {
  console.error(`SMOKE FAILED: ${msg}`);
  process.exit(code);
}

const rawUrl = process.env['SUPABASE_URL']?.trim().replace(/\/+$/, '');
const rawKey = process.env['SUPABASE_SERVICE_KEY']?.trim();
const bucketRaw = process.env['SUPABASE_STORAGE_BUCKET']?.trim();
const bucket = bucketRaw && bucketRaw.length > 0 ? bucketRaw : BUCKET_DEFAULT;
if (!rawUrl || !rawKey) {
  console.error(
    'SUPABASE_URL and SUPABASE_SERVICE_KEY are required in the environment. ' +
    `SUPABASE_STORAGE_BUCKET is optional (defaults to \`${BUCKET_DEFAULT}\`). Refusing to run.`,
  );
  process.exit(2);
}
const url: string = rawUrl;
const serviceKey: string = rawKey;

function objectUrl(base: string, bkt: string, key: string): string {
  const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${base}/storage/v1/object/${encodeURIComponent(bkt)}/${encoded}`;
}

const stamp = new Date().toISOString().replaceAll(':', '-');
const rand = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
const key = `test/smoke/${stamp}-${rand}.txt`;
const content = `bhasya storage smoke ${rand} ${stamp}`;

const adapter = new SupabaseStorageAdapter({ url, serviceKey, bucket });
// Raw REST DELETE only (StoragePort has no delete; contract unchanged).
async function restDelete(): Promise<{ ok: boolean; status: number; detail: string }> {
  const res = await fetch(objectUrl(url, bucket, key), {
    method: 'DELETE',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const detail = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, detail: detail.slice(0, 200) };
}

let putOk = false;
let getOk = false;
let contentOk = false;
let deleteOk = false;
let missingOk = false;

try {
  await adapter.put(key, content, 'text/plain');
  putOk = true;
  console.log(`PUT ok bucket=${bucket} key=${key} bytes=${new TextEncoder().encode(content).length}`);

  const back = await adapter.get(key);
  if (back === null) fail(`GET returned null for ${key}`);
  getOk = true;
  const text = new TextDecoder().decode(back as Uint8Array);
  console.log(`GET ok bytes=${(back as Uint8Array).length}`);
  if (text !== content) fail('content mismatch (GET bytes differ from PUT bytes)');
  contentOk = true;
  console.log('CONTENT verified (exact match)');

  const del = await restDelete();
  if (!del.ok) fail(`DELETE failed (${del.status}): ${del.detail}`);
  deleteOk = true;
  console.log(`DELETE ok status=${del.status}`);

  const after = await adapter.get(key);
  if (after !== null) fail('object still present after DELETE');
  missingOk = true;
  console.log('MISSING verified (GET after DELETE returned null)');

  console.log('SUPABASE STORAGE SMOKE COMPLETE');
} finally {
  // Best-effort cleanup even when verification above failed.
  try {
    const check = await adapter.get(key).catch(() => new Uint8Array());
    if (check !== null) {
      const retry = await restDelete().catch(() => ({ ok: false, status: -1, detail: '' }));
      if (retry.ok) console.log('CLEANUP delete ok');
      else console.log('CLEANUP nothing left to delete (or already removed)');
    }
  } catch {
    /* cleanup must never mask the original result */
  }
}

if (!putOk || !getOk || !contentOk || !deleteOk || !missingOk) {
  fail('incomplete smoke (see steps above)');
}
