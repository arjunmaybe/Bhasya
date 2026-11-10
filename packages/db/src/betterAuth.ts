/**
 * Better Auth instance (owns authentication/session lifecycle).
 *
 * - Better Auth owns its own tables (`user`/`session`/`account`/`verification`)
 *   via its Kysely adapter. The app's canonical `users` table links via the
 *   additive `users.external_user_id` (003, Better Auth user id).
 * - The SAME underlying database is shared: pg `Pool` in production, the same
 *   PGlite instance in dev/tests. No second connection / second database.
 * - No static `better-auth` / `kysely` / `node:*` imports here so the
 *   Cloudflare Worker entry stays importable (dynamic imports only, same
 *   pattern as `index.ts` / `storage.ts`). Type-only imports are erased.
 */

import type { DbClient } from './index.js';

type AuthInstance = {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (args: { headers: Headers }) => Promise<{
      user: { id: string; email: string; name?: string | null; emailVerified?: boolean };
    } | null>;
  };
  options: unknown;
};

const kyselyCache = new WeakMap<object, unknown>();
const authCache = new WeakMap<object, Promise<AuthInstance>>();

let warnedDefaultSecret = false;

export function readBetterAuthEnv(key: string, env?: Record<string, unknown>): string | undefined {
  const fromEnv = env?.[key];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  } catch { /* no process in Workers */ }
  return undefined;
}

function resolveSecret(env?: Record<string, unknown>): string {
  const s = readBetterAuthEnv('BETTER_AUTH_SECRET', env);
  if (s) return s;
  if (!warnedDefaultSecret) {
    warnedDefaultSecret = true;
    try { console.warn('[bhasya] BETTER_AUTH_SECRET unset — using validation-only dev secret'); } catch { /* ignore */ }
  }
  return 'bhasya-dev-secret-0123456789abcdef-000000';
}

function resolveBaseURL(env?: Record<string, unknown>): string {
  return readBetterAuthEnv('BETTER_AUTH_URL', env) ?? 'http://localhost:8787';
}

/**
 * Validate one explicit origin. Wildcards, credentials, paths, queries, and
 * fragments are configuration errors — never silently ignored.
 */
function parseExplicitOrigin(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute http(s) origin`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) throw new Error(`${label} must not include credentials`);
  if (url.search || url.hash) throw new Error(`${label} must not include a query or fragment`);
  if (url.pathname !== '/') throw new Error(`${label} must be an origin without a path`);
  return url.origin;
}

/**
 * Browser origin allowed to call Better Auth. Trusted origins are exactly the
 * configured value plus Better Auth's own baseURL origin; request Host and
 * forwarding headers are never consulted (see `trustedProxyHeaders` below).
 * Unset means "contribute no extra origin" and keeps staging/tests working.
 */
function resolveWebOrigin(env?: Record<string, unknown>): string | null {
  const raw = readBetterAuthEnv('BHASYA_WEB_ORIGIN', env)?.trim();
  if (!raw) return null;
  if (raw === '*') throw new Error('BHASYA_WEB_ORIGIN must be one explicit origin, not "*"');
  const origin = parseExplicitOrigin(raw, 'BHASYA_WEB_ORIGIN');
  if (resolveBaseURL(env).startsWith('https://') && !origin.startsWith('https://')) {
    throw new Error('BHASYA_WEB_ORIGIN must use https when BETTER_AUTH_URL is https');
  }
  return origin;
}

function isLoopbackBaseURL(env?: Record<string, unknown>): boolean {
  try {
    const url = new URL(resolveBaseURL(env));
    const host = url.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Public sign-up policy.
 *
 * - An explicit `BHASYA_DISABLE_SIGNUP=1` always wins and cannot be overridden.
 * - Sign-up is enabled only under Vitest or an explicitly configured local
 *   Worker smoke test (`BHASYA_TEST_SIGNUP=1` and a loopback BETTER_AUTH_URL).
 * - Every authenticated staging/production deployment is closed by default.
 *
 * Account provisioning is an operator action (wrangler secret/DB access), not
 * a public registration flow. See AGENTS.md security rules.
 */
function resolveDisableSignUp(env?: Record<string, unknown>): boolean {
  if (readBetterAuthEnv('BHASYA_DISABLE_SIGNUP', env) === '1') return true;
  const nodeEnv = readBetterAuthEnv('NODE_ENV', env);
  const vitest = readBetterAuthEnv('VITEST', env);
  const testLike = nodeEnv === 'test' || (nodeEnv === undefined && (vitest === 'true' || vitest === '1'));
  if (testLike) return false;
  const localSmoke = readBetterAuthEnv('BHASYA_TEST_SIGNUP', env) === '1' && isLoopbackBaseURL(env);
  return !localSmoke;
}

async function getKyselyForDb(db: DbClient): Promise<unknown> {
  const hit = kyselyCache.get(db as object);
  if (hit) return hit;
  const { Kysely, PostgresDialect, PGliteDialect } = await import('kysely');
  const rec = db as unknown as { pool?: unknown; pglite?: unknown };
  let dialect: unknown;
  if (rec.pool) {
    dialect = new (PostgresDialect as new (o: unknown) => unknown)({ pool: rec.pool });
  } else if (typeof (rec as { checkout?: unknown }).checkout === 'function') {
    // Hyperdrive/request-scoped path: the facade holds no connections — each
    // Kysely checkout opens a fresh client the dialect releases after use
    // (proven in tests/hyperdrive-lifecycle.test.ts, incl. tx commit/rollback).
    const checkout = (rec as { checkout: () => Promise<{ query: (t: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>; release: () => Promise<void> }> }).checkout;
    const fakePool: { connect: () => Promise<unknown>; on: () => unknown; end: () => Promise<void> } = {
      connect: async () => {
        const c = await checkout();
        return { query: (t: string, p?: unknown[]) => c.query(t, p), release: () => c.release() };
      },
      on: () => fakePool,
      end: async () => undefined,
    };
    dialect = new (PostgresDialect as new (o: unknown) => unknown)({ pool: fakePool });
  } else if (rec.pglite) {
    dialect = new (PGliteDialect as new (o: unknown) => unknown)({ pglite: rec.pglite });
  } else {
    throw new Error('Better Auth needs the underlying database handle (pg Pool or PGlite instance)');
  }
  const kysely = new (Kysely as new (o: unknown) => unknown)({ dialect });
  kyselyCache.set(db as object, kysely);
  return kysely;
}

/** Better Auth instance bound to the given DbClient (cached per DbClient). */
export function getAuthForDb(db: DbClient, opts: { env?: Record<string, unknown> } = {}): Promise<AuthInstance> {
  const hit = authCache.get(db as object);
  if (hit) return hit;
  const p = createAuthInstance(db, opts);
  authCache.set(db as object, p);
  return p;
}

async function createAuthInstance(
  db: DbClient, opts: { env?: Record<string, unknown>; validateSchema?: boolean } = {},
): Promise<AuthInstance> {
  const { betterAuth } = await import('better-auth');
  // Bearer plugin: converts `Authorization: Bearer <session token>` into the
  // session cookie before endpoints run, so `get-session` (and therefore the
  // app identity boundary, which calls `auth.api.getSession({ headers })`)
  // accepts Bearer tokens as well as cookies. Without this plugin,
  // Bearer-only requests resolve to a null session. Dynamic import keeps the
  // Cloudflare Worker entry importable (no static `better-auth/*` imports).
  const { bearer } = await import('better-auth/plugins');
  const kysely = await getKyselyForDb(db);
  const webOrigin = resolveWebOrigin(opts.env);
  const disableSignUp = resolveDisableSignUp(opts.env);
  const auth = (betterAuth as (o: unknown) => AuthInstance)({
    baseURL: resolveBaseURL(opts.env),
    secret: resolveSecret(opts.env),
    // Only explicit origins: Better Auth's baseURL origin (added by the
    // library) plus the configured web origin. No wildcard, no function that
    // reads Host / x-forwarded-* from the request.
    trustedOrigins: webOrigin ? [webOrigin] : [],
    emailAndPassword: { enabled: true, requireEmailVerification: false, autoSignIn: true, disableSignUp },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    database: { db: kysely, type: 'postgres', transaction: true },
    plugins: [(bearer as () => unknown)()],
    advanced: {
      database: { validateSchema: opts.validateSchema ?? true },
      // Trust is configured, never inferred from proxy headers.
      trustedProxyHeaders: false,
    },
  });
  return auth;
}

/** Create Better Auth core tables if missing (idempotent, pg + PGlite). */
export async function ensureBetterAuthSchema(db: DbClient): Promise<void> {
  // Ephemeral migration instance with validation off: on a fresh database the
  // core tables don't exist yet, and validating before creating them only
  // logs a mismatch. The cached production instance (validation on) is
  // created afterwards against the migrated schema, so real requests still
  // get schema validation.
  const migrationAuth = await createAuthInstance(db, { validateSchema: false });
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await (getMigrations as (o: unknown) => Promise<{ runMigrations: () => Promise<unknown> }>)(
    (migrationAuth as unknown as { options: unknown }).options,
  );
  await runMigrations();
}
