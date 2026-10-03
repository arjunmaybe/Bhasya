import { createApp } from './app.js';
import { getServices } from './services.js';

/**
 * Locked $0 gateway: Cloudflare → Cloudflare Worker → Hono API →
 * Supabase PostgreSQL/pgvector + Supabase Storage behind StoragePort
 * (ARCHITECTURE.md, authoritative + frozen). R2 is an optional future
 * StoragePort provider only and is never required for $0 staging.
 *
 * This entry serves the SAME Hono router and contracts as local dev
 * (`dev.ts` serves this app via `@hono/node-server`; that adapter is
 * local-development only and is not a production backend). No alternative
 * runtime, no contract changes here.
 *
 * Worker bindings required (wrangler secrets/vars — never committed):
 * - DATABASE_URL ......... Supabase PostgreSQL/pgvector ($0 staging secret;
 *   Hyperdrive optional, production profile only)
 * - BHASYA_MODEL_API_KEY / BHASYA_MODEL_ID / BHASYA_MODEL_ENDPOINT (real AI)
 * - BHASYA_USE_AUTH=1 + Better Auth secrets (production session lifecycle;
 *   the Hono boundary resolves the session via getIdentityForRequest)
 * - $0 staging storage (no R2 billing): Supabase Storage behind the same
 *   StoragePort via SUPABASE_URL + SUPABASE_SERVICE_KEY (+ optional
 *   SUPABASE_STORAGE_BUCKET, default `bhasya-artifacts`, private bucket).
 * - Optional future production storage: R2 bucket binding
 *   (e.g. BHASYA_BUCKET, `[env.production]` only). R2 wins when present;
 *   default $0 staging needs no R2 binding and fails closed only when
 *   neither Supabase env nor R2 binding is configured (LocalStorageAdapter
 *   is local-dev only and has no filesystem on Workers).
 *
 * Deployment wiring (wrangler.toml + secrets) is an ops step with real
 * bindings; it is intentionally not simulated with dev adapters here.
 *
  * Runtime notes:
  * - No `node:*` imports on this path: hashing uses pure-JS SHA-256 +
  *   Web Crypto, IDs use `crypto.randomUUID()`, storage is Supabase Storage
  *   ($0 baseline) or R2 (optional future) behind StoragePort, DB is
  *   PostgreSQL via DATABASE_URL. PGlite/filesystem adapters are never
  *   constructed here.
 * - Production never seeds the dev user (see getServices: BHASYA_USE_AUTH=1
 *   skips seedDev). Identity is server-derived from the Better Auth session.
 */

const RUNTIME_KEYS = [
  'DATABASE_URL',
  'BHASYA_MODEL_API_KEY',
  'BHASYA_MODEL_ID',
  'BHASYA_MODEL_ENDPOINT',
  'BHASYA_USE_AUTH',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_STORAGE_BUCKET',
] as const;

/** Expose Worker env through the existing configuration points (no new config). */
function applyEnv(env: Record<string, unknown>): void {
  let proc: { env?: Record<string, string> } | undefined;
  try {
    proc = (globalThis as { process?: { env?: Record<string, string> } }).process;
  } catch {
    return;
  }
  if (!proc || typeof proc.env !== 'object') return;
  for (const k of RUNTIME_KEYS) {
    const v: unknown = env?.[k];
    if (typeof v === 'string' && v.length > 0 && !proc.env[k]) proc.env[k] = v;
  }
}

let app: ReturnType<typeof createApp> | null = null;
let init: Promise<void> | null = null;
let initEnvKey = '';

function envKey(env: Record<string, unknown>): string {
  // Cache-bust only on binding identity that affects service wiring.
  const db = typeof env['DATABASE_URL'] === 'string' ? (env['DATABASE_URL'] as string).slice(0, 32) : '';
  const auth = typeof env['BHASYA_USE_AUTH'] === 'string' ? (env['BHASYA_USE_AUTH'] as string) : '';
  const hasR2 = env['BHASYA_BUCKET'] ?? env['BHASYA_R2'] ?? env['R2'] ?? env['BUCKET'];
  const supabase = typeof env['SUPABASE_URL'] === 'string' ? (env['SUPABASE_URL'] as string).slice(0, 32) : '';
  const supabaseBucket = typeof env['SUPABASE_STORAGE_BUCKET'] === 'string' ? (env['SUPABASE_STORAGE_BUCKET'] as string) : '';
  const hd = env['HYPERDRIVE'] ? 'hd' : 'no-hd';
  return `${db}|${auth}|${hasR2 ? 'r2' : 'no-r2'}|${supabase}|${supabaseBucket}|${hd}`;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    applyEnv(env);
    if (!app) app = createApp();
    // Fail closed: production sessions require a real secret. The library
    // falls back to a validation-only dev secret when unset, which must never
    // serve production traffic.
    const prodFlag = typeof env?.['BHASYA_USE_AUTH'] === 'string'
      ? (env['BHASYA_USE_AUTH'] as string)
      : (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.['BHASYA_USE_AUTH'];
    if (prodFlag === '1') {
      const secret = typeof env?.['BETTER_AUTH_SECRET'] === 'string' && (env['BETTER_AUTH_SECRET'] as string).length > 0
        ? (env['BETTER_AUTH_SECRET'] as string)
        : (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.['BETTER_AUTH_SECRET'];
      if (!secret) {
        return Response.json({ error: 'BETTER_AUTH_SECRET required in production (wrangler secret)' }, { status: 500 });
      }
    }
    // Same services, same contracts: Supabase PostgreSQL/pgvector + Supabase
    // Storage ($0 baseline; R2 optional future) + Better Auth sessions.
    // Fails fast without a configured storage backend instead of falling
    // back to PGlite/filesystem/dev identity.
    const key = envKey(env ?? {});
    if (!init || initEnvKey !== key) {
      initEnvKey = key;
      init = getServices({ env: env ?? {} }).then(() => undefined);
    }
    try {
      await init;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'service init failed';
      return Response.json({ error: msg }, { status: 500 });
    }
    return app.fetch(request);
  },
};

/** Test hook: reset cached app/services between Worker-runtime verifications. */
export function __resetWorkerForTests(): void {
  app = null;
  init = null;
  initEnvKey = '';
}
