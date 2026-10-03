import type { DbClient } from './index.js';
import { seedDev } from './index.js';
import { getAuthForDb } from './betterAuth.js';

export type Identity = { userId: string; workspaceId: string; email: string };

/**
 * Production authentication boundary — the actual Better Auth library owns
 * the session lifecycle.
 *
 * - Production (`BHASYA_USE_AUTH=1`): identity is resolved server-side from
 *   the Better Auth session via `auth.api.getSession({ headers })`. The app
 *   user (`users` row) is derived from the Better Auth user id through the
 *   additive `users.external_user_id` link (003); the workspace is then
 *   derived from the database — never from query parameters or arbitrary
 *   request headers.
 * - Local development (`BHASYA_USE_AUTH` unset): single seeded dev
 *   user/workspace via `seedDev()`. This path is validation-only and never
 *   runs in production.
 *
 * Explicit non-goals (never authoritative):
 * - `?user=`, `?workspace=`, `x-dev-user`, `x-user-id`, or any other
 *   client-supplied selector. These are ignored entirely.
 *
 * Legacy custom `auth_sessions` helpers below are deprecated and NOT used for
 * authentication; they remain only so existing databases still migrate.
 */

const SESSION_COOKIE_NAMES = ['__Secure-better-auth.session_token', 'better-auth.session_token'];
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUTH_SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
`.trim();

function readEnv(key: string, env?: Record<string, unknown>): string | undefined {
  const fromEnv = env?.[key];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  } catch { /* no process in Workers */ }
  return undefined;
}

export function isProductionAuth(env?: Record<string, unknown>): boolean {
  return readEnv('BHASYA_USE_AUTH', env) === '1';
}

/** Dev identity (validation convenience, NOT a replacement for Better Auth). */
export async function getDevIdentity(db: DbClient): Promise<Identity> {
  const s = await seedDev(db);
  return { ...s, email: 'dev@bhasya.local' };
}

// ── Legacy custom session helpers (DEPRECATED) ────────────────────────────
// The `auth_sessions` table (002) is NOT Better Auth and is NOT consulted by
// `getIdentityForRequest`. Better Auth owns sessions in its own tables.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa exists in Node 20+ and Workers.
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isPglite(db: DbClient): boolean {
  return (db as unknown as Record<string, unknown>).dialect === 'pglite';
}

/** Ensure the Better Auth session table exists (idempotent, Worker-safe fallback). */
export async function ensureAuthTables(db: DbClient): Promise<void> {
  let ddl = AUTH_SESSIONS_DDL;
  if (isPglite(db)) {
    ddl = ddl.replaceAll('gen_random_uuid()', 'uuid_generate_v4()');
  }
  for (const st of ddl.split(';')) {
    const s = st.trim();
    if (!s) continue;
    try {
      await db.query(s);
    } catch (e: unknown) {
      if (/already exists|duplicate/i.test(String((e as Error)?.message ?? e))) continue;
      throw e;
    }
  }
}

export async function createAuthSession(
  db: DbClient, userId: string, opts: { ttlMs?: number } = {},
): Promise<{ token: string; expiresAt: Date }> {
  await ensureAuthTables(db);
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`,
    [tokenHash, userId, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

export async function invalidateSession(db: DbClient, token: string): Promise<void> {
  try {
    const tokenHash = await hashSessionToken(token);
    await db.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [tokenHash]);
  } catch { /* best effort */ }
}

async function resolveWorkspaceForUser(db: DbClient, userId: string): Promise<string | null> {
  const owned = (await db.query(
    `SELECT id FROM workspaces WHERE owner_user_id = $1 LIMIT 1`, [userId],
  )).rows[0] as { id?: unknown } | undefined;
  if (owned?.id) return String(owned.id);
  const member = (await db.query(
    `SELECT workspace_id AS id FROM workspace_members WHERE user_id = $1 LIMIT 1`, [userId],
  )).rows[0] as { id?: unknown } | undefined;
  if (member?.id) return String(member.id);
  // Auto-provision a workspace for first-time Better Auth users so the
  // frozen resolver/authorization pipeline (membership-gated) still applies.
  // No client input influences this — owner is the session user.
  const ws = (await db.query(
    `INSERT INTO workspaces (name, owner_user_id) VALUES ($1,$2) RETURNING id`,
    ['Workspace', userId],
  )).rows[0] as { id?: unknown } | undefined;
  if (!ws?.id) return null;
  const wsId = String(ws.id);
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [wsId, userId],
  );
  return wsId;
}

/** Link the canonical app user to the Better Auth user (by id, else email). */
async function findOrCreateAppUser(
  db: DbClient, betterUserId: string, email: string, name?: string | null,
): Promise<{ userId: string; email: string } | null> {
  const cleanEmail = email.trim().toLowerCase();
  try {
    const byLink = (await db.query(
      `SELECT id, email FROM users WHERE external_user_id = $1 LIMIT 1`, [betterUserId],
    )).rows[0] as { id?: unknown; email?: unknown } | undefined;
    if (byLink?.id) return { userId: String(byLink.id), email: String(byLink.email ?? cleanEmail) };
  } catch { /* 003 not yet migrated (old DB): fall through to email */ }
  if (cleanEmail) {
    const byEmail = (await db.query(
      `SELECT id, email FROM users WHERE email = $1 LIMIT 1`, [cleanEmail],
    )).rows[0] as { id?: unknown; email?: unknown } | undefined;
    if (byEmail?.id) {
      try {
        await db.query(`UPDATE users SET external_user_id = $1 WHERE id = $2`, [betterUserId, String(byEmail.id)]);
      } catch { /* column missing on very old DB; identity still resolves by email row */ }
      return { userId: String(byEmail.id), email: String(byEmail.email ?? cleanEmail) };
    }
  }
  const displayName = (name ?? '').trim() || cleanEmail || 'User';
  try {
    const created = (await db.query(
      `INSERT INTO users (email, display_name, external_user_id) VALUES ($1,$2,$3) RETURNING id, email`,
      [cleanEmail || `user-${betterUserId.slice(0, 8)}@bhasya.local`, displayName, betterUserId],
    )).rows[0] as { id?: unknown; email?: unknown } | undefined;
    if (created?.id) return { userId: String(created.id), email: String(created.email ?? cleanEmail) };
  } catch {
    // Column missing (old DB without 003): create without the link.
    const created = (await db.query(
      `INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id, email`,
      [cleanEmail || `user-${betterUserId.slice(0, 8)}@bhasya.local`, displayName],
    )).rows[0] as { id?: unknown; email?: unknown } | undefined;
    if (created?.id) return { userId: String(created.id), email: String(created.email ?? cleanEmail) };
  }
  return null;
}

export async function getIdentityForRequest(
  db: DbClient, headers: Headers, opts: { env?: Record<string, unknown> } = {},
): Promise<Identity | null> {
  // Local development only: single seeded identity. Production never takes
  // this branch (BHASYA_USE_AUTH=1 is set via Worker bindings/secrets).
  if (!isProductionAuth(opts.env)) {
    return getDevIdentity(db);
  }
  // Production: the actual Better Auth session only. `headers` is the ONLY
  // input — the signature deliberately has no URL/query argument, so `?user=`-
  // style selectors cannot influence identity. Arbitrary headers (`x-dev-user`,
  // `x-user-id`, …) are not read here and therefore do nothing.
  let session: { user: { id: string; email: string; name?: string | null } } | null;
  try {
    const auth = await getAuthForDb(db, { env: opts.env });
    session = await auth.api.getSession({ headers });
  } catch {
    return null;
  }
  const u = (session as unknown as { user?: { id?: unknown; email?: unknown; name?: unknown } } | null)?.user;
  if (!u || typeof u.id !== 'string' || !u.id) return null;
  const appUser = await findOrCreateAppUser(db, u.id, typeof u.email === 'string' ? u.email : '', typeof u.name === 'string' ? u.name : null);
  if (!appUser) return null;
  const workspaceId = await resolveWorkspaceForUser(db, appUser.userId);
  if (!workspaceId) return null;
  return { userId: appUser.userId, workspaceId, email: appUser.email };
}
