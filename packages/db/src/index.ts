/**
 * Database boundary.
 *
 * - Production: `DATABASE_URL` (PostgreSQL/pgvector, Hyperdrive in Workers).
 * - Local dev/test: PGlite (same Postgres dialect) when no server is set.
 *
 * This module has NO static `node:*` imports so the Cloudflare Worker entry
 * (`apps/api/src/worker.ts`, same Hono router) can import it. Node-only
 * modules are loaded lazily inside functions.
 */

export type DbQueryResult = { rows: Array<Record<string, any>>; rowCount: number };
export type DbCheckout = {
  query: (text: string, params?: unknown[]) => Promise<DbQueryResult>;
  release: () => Promise<void>;
};

export type DbClient = {
  query: (text: string, params?: unknown[]) => Promise<DbQueryResult>;
  close?: () => Promise<void>;
  /** Underlying handles retained so Better Auth can share the SAME database
   * (same connection / same PGlite instance) instead of opening a second one.
   * Additive only — existing callers ignore these. */
  pool?: unknown;
  pglite?: unknown;
  dialect?: string;
  /**
   * Request-scoped mode (Cloudflare guidance: TCP sockets should be created
   * inside a request handler rather than globally shared; Supabase documents
   * stale persistent TCP connections as a cause of hanging queries). When
   * present, `checkout` opens a fresh `pg.Client` the caller releases;
   * nothing is retained between requests, so this DbClient is safe to cache
   * and share. `transact` runs fn on one checked-out connection
   * (BEGIN/COMMIT). Both Hyperdrive and direct-DATABASE_URL pg clients set
   * these; PGlite clients never do. `hyperdrive: true` only marks which
   * connection string was selected (HYPERDRIVE binding vs DATABASE_URL).
   */
  hyperdrive?: boolean;
  checkout?: () => Promise<DbCheckout>;
  transact?: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
};

function getProcessEnv(key: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = proc?.env?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
  } catch { /* Workers have no process */ }
  return undefined;
}

function getCwd(): string | undefined {
  try {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
  } catch {
    return undefined;
  }
}

async function readMigrationFile(name: string): Promise<string | null> {
  try {
    const [{ readFileSync, existsSync }, { join, dirname }, { fileURLToPath }] = await Promise.all([
      import('node:fs'),
      import('node:path'),
      import('node:url'),
    ]);
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', '..', '..', 'db', 'migrations', name),
    ];
    const cwd = getCwd();
    if (cwd) {
      candidates.push(join(cwd, 'db', 'migrations', name));
      // When running from apps/api (dev server), cwd is D:/Bhasya/apps/api;
      // migrations live at the repo root.
      candidates.push(join(cwd, '..', '..', 'db', 'migrations', name));
      candidates.push(join(cwd, '..', 'db', 'migrations', name));
    }
    for (const c of candidates) {
      try {
        if (existsSync(c)) return readFileSync(c, 'utf8');
      } catch { /* try next */ }
    }
    return null;
  } catch {
    // No node:fs (Cloudflare Workers): migration files are unavailable here.
    // Production databases are migrated externally (`npm run db:migrate`
    // against PostgreSQL before Worker deploy). Auth tables additionally have
    // an embedded DDL fallback via ensureAuthTables().
    return null;
  }
}

function stripVectorForNonVectorDb(sql: string): string {
  // PGlite without the vector extension cannot parse `vector(1536)`.
  // Production PostgreSQL always has pgvector; this fallback exists only so
  // unit tests run on minimal environments. The canonical type remains vector.
  return sql
    .replace('CREATE EXTENSION IF NOT EXISTS "vector";', '-- vector extension unavailable in this dev runtime')
    .replaceAll('embedding vector(1536),', 'embedding TEXT,');
}

function forPglite(sql: string): string {
  // PGlite dev-runtime rewrite (dev/test ONLY — frozen files untouched,
  // production runs them verbatim). PGlite cannot load pgcrypto, so
  // gen_random_uuid() maps to uuid_generate_v4() (extension "uuid-ossp" in
  // PGlite's build). Same UUID PK contract, same dialect.
  return sql
    .replaceAll('CREATE EXTENSION IF NOT EXISTS "pgcrypto";', 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')
    .replaceAll('gen_random_uuid()', 'uuid_generate_v4()');
}

/** Open a database client. Production: DATABASE_URL (pg). Dev/test: PGlite. */
export async function openDb(
  opts: { databaseUrl?: string; dataDir?: string; env?: Record<string, unknown>; hyperdrive?: boolean } = {},
): Promise<DbClient> {
  const envUrl = opts.env?.['DATABASE_URL'];
  const url =
    opts.databaseUrl ??
    (typeof envUrl === 'string' && envUrl.length > 0 ? envUrl : undefined) ??
    getProcessEnv('DATABASE_URL');
  if (url && opts.hyperdrive) {
    // Hyperdrive path: per-request/per-checkout pg.Client (never a cached
    // Pool). Each checkout connects, runs, and ends its client, so no
    // connection is ever held across Worker invocations; Hyperdrive owns the
    // underlying origin pooling. Direct-DATABASE_URL behavior below is untouched.
    const { Client } = await import('pg');
    const checkout = async (): Promise<DbCheckout> => {
      const client = new Client({ connectionString: url });
      await client.connect();
      let released = false;
      return {
        query: async (text, params) => {
          const r = await client.query(text, params as any[]);
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        },
        release: async () => {
          if (released) return;
          released = true;
          try { await client.end(); } catch { /* ignore */ }
        },
      };
    };
    const query = async (text: string, params?: unknown[]): Promise<DbQueryResult> => {
      const c = await checkout();
      try {
        return await c.query(text, params);
      } finally {
        await c.release();
      }
    };
    const transact = async <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> => {
      const c = await checkout();
      const txDb: DbClient = { hyperdrive: true, query: (t, p) => c.query(t, p) };
      await c.query('BEGIN');
      try {
        const out = await fn(txDb);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally {
        await c.release();
      }
    };
    return { hyperdrive: true, checkout, query, transact, close: async () => undefined };
  }
  if (url) {
    // Direct DATABASE_URL: per-operation pg.Client (never a cached Pool).
    // Remote diagnostic proved fresh Client/Pool succeed while a reused
    // isolate-cached Pool fails on second use (pool age ~2.7s, 20s
    // `Query read timeout` on a stale TCP socket). Cloudflare requires TCP
    // sockets be created inside the request handler, not shared across
    // requests; Supabase documents stale persistent TCP as hanging-query
    // cause. Each query/checkout connects, runs, and ends its client, so no
    // socket is ever held across Worker invocations. Transport unchanged
    // (same DATABASE_URL via `pg`); only the lifecycle is fixed. Cached
    // Services facade is now safe to share (holds only the connection
    // string). Transactions use one checked-out client (BEGIN…COMMIT).
    // Existing 20s client-side read timeout preserved (fail-fast JSON 500,
    // not increased); legitimate queries are millisecond-scale.
    const { Client } = await import('pg');
    const checkout = async (): Promise<DbCheckout> => {
      const client = new Client({ connectionString: url, query_timeout: 20_000 } as Record<string, unknown>);
      await client.connect();
      let released = false;
      return {
        query: async (text, params) => {
          const r = await client.query(text, params as any[]);
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        },
        release: async () => {
          if (released) return;
          released = true;
          try { await client.end(); } catch { /* ignore */ }
        },
      };
    };
    const query = async (text: string, params?: unknown[]): Promise<DbQueryResult> => {
      const c = await checkout();
      try {
        return await c.query(text, params);
      } finally {
        await c.release();
      }
    };
    const transact = async <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> => {
      const c = await checkout();
      const txDb: DbClient = { query: (t, p) => c.query(t, p) };
      await c.query('BEGIN');
      try {
        const out = await fn(txDb);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally {
        await c.release();
      }
    };
    return { checkout, query, transact, close: async () => undefined };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  type Extension = import('@electric-sql/pglite').Extension;
  const extensions: Record<string, Extension> = {};
  try {
    const { vector } = await import('@electric-sql/pglite/vector');
    extensions['vector'] = vector;
  } catch { /* pgvector unavailable in this runtime */ }
  try {
    const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');
    extensions['uuid_ossp'] = uuid_ossp;
  } catch { /* uuid-ossp unavailable in this runtime */ }
  const cwd = getCwd();
  const dataDir = opts.dataDir ?? (cwd ? `${cwd}/.bhasya-pglite` : 'memory://');
  const db = new PGlite(dataDir, { extensions });
  await db.waitReady;
  const client: DbClient = {
    pglite: db,
    dialect: 'pglite',
    query: async (text, params) => {
      const r = await db.query(text, params as any[]);
      return { rows: r.rows as Array<Record<string, any>>, rowCount: r.affectedRows ?? (r.rows?.length ?? 0) };
    },
    close: async () => { await db.close(); },
  };
  return client;
}

/** Split SQL into single statements (dollar-quote and comment aware). */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inLine = false, inBlock = false, inSingle = false, inDouble = false;
  while (i < sql.length) {
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += sql[i++]; continue;
    }
    const two = sql.slice(i, i + 2);
    if (inLine) { buf += sql[i++]; if (sql[i - 1] === '\n') inLine = false; continue; }
    if (inBlock) {
      if (two === '*/') { buf += two; i += 2; inBlock = false; } else buf += sql[i++];
      continue;
    }
    if (inSingle) {
      buf += sql[i];
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") buf += sql[++i];
        else inSingle = false;
      }
      i++; continue;
    }
    if (inDouble) { buf += sql[i]; if (sql[i] === '"') inDouble = false; i++; continue; }
    if (two === '--') { inLine = true; buf += two; i += 2; continue; }
    if (two === '/*') { inBlock = true; buf += two; i += 2; continue; }
    if (sql[i] === "'") { inSingle = true; buf += sql[i++]; continue; }
    if (sql[i] === '"') { inDouble = true; buf += sql[i++]; continue; }
    const dm = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
    if (dm) { dollarTag = dm[0]; buf += dollarTag; i += dollarTag.length; continue; }
    if (sql[i] === ';') {
      buf += ';';
      const s = buf.trim();
      if (s && s !== ';') out.push(s);
      buf = ''; i++; continue;
    }
    buf += sql[i++];
  }
  const rest = buf.trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * Expected schema marker (mirrors db/migrations/001→003 + Better Auth core
 * tables; same lists as scripts/migrate-staging.ts verification readout).
 *
 * Every Worker cold start runs migrate() before serving (apps/api/src/worker.ts),
 * and each statement is a sequential round trip. Over the edge→PostgreSQL link
 * the full DDL replay costs ~50 round trips per cold isolate even when the
 * database is already current — enough to exceed client/server timeouts at low
 * traffic, where nearly every request finds a cold isolate. The fast path below
 * reduces the current-schema case to ~3 round trips with an identical end state.
 * Fresh or partially-migrated databases always take the full replay path.
 * If a future migration (004+) adds tables/columns, extend these lists alongside.
 */
const MIGRATED_APP_TABLES = [
  'users',
  'workspaces',
  'workspace_members',
  'sources',
  'document_versions',
  'document_nodes',
  'passages',
  'anchors',
  'highlights',
  'threads',
  'thread_messages',
  'evidence',
  'citations',
  'embeddings',
  'event_log',
  'auth_sessions',
];
const MIGRATED_AUTH_TABLES = ['user', 'session', 'account', 'verification'];

/** True when the database already carries the full current schema. Never throws: unknown state → full replay. */
async function isSchemaCurrent(db: DbClient): Promise<boolean> {
  try {
    const tbl = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const found = new Set(tbl.rows.map((r) => String((r as Record<string, unknown>)['tablename'])));
    for (const t of [...MIGRATED_APP_TABLES, ...MIGRATED_AUTH_TABLES]) {
      if (!found.has(t)) return false;
    }
    const col = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'external_user_id'`,
    );
    if (col.rows.length === 0) return false;
    return true;
  } catch {
    return false;
  }
}

export async function migrate(db: DbClient): Promise<void> {
  // Fast path: schema already current → run only Better Auth's tracked
  // incremental migrations (no-ops when current). Fresh/partial databases fall
  // through to the full replay below; end state is identical either way.
  if (await isSchemaCurrent(db)) {
    const { ensureBetterAuthSchema } = await import('./betterAuth.js');
    await ensureBetterAuthSchema(db);
    return;
  }
  const isPglite = (db as unknown as Record<string, unknown>).dialect === 'pglite';
  const runAll = async (text: string) => {
    const sql = isPglite ? forPglite(text) : text;
    for (const st of splitStatements(sql)) {
      try {
        await db.query(st);
      } catch (e: any) {
        if (/already exists|duplicate/i.test(String(e?.message ?? e))) continue;
        throw e;
      }
    }
  };
  const runAllWithVectorFallback = async (text: string) => {
    try {
      await runAll(text);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/vector/i.test(msg)) {
        // Dev runtime without pgvector: canonical type stays `vector` in the
        // frozen schema; this TEXT fallback is test/dev-only.
        await runAll(stripVectorForNonVectorDb(text));
      } else throw e;
    }
  };

  // Ordered migrations. 001 is FROZEN; 002 adds the legacy custom session
  // table (kept for existing databases, NOT used for auth); 003 adds the
  // additive app-user link to the Better Auth user. None touch the canonical
  // document model.
  const files = ['001_initial_schema.sql', '002_auth_sessions.sql', '003_app_users_external_id.sql'];
  let loadedAny = false;
  for (const name of files) {
    const sql = await readMigrationFile(name);
    if (!sql) {
      if (name === '001_initial_schema.sql') continue; // fall through to embedded check below
      continue;
    }
    loadedAny = true;
    await runAllWithVectorFallback(sql);
  }
  if (!loadedAny) {
    // No migration files available (Cloudflare Worker bundle has no node:fs).
    // Bootstrap the SAME frozen schema in the SAME order as the file path
    // above (001 → 002 → 003 → Better Auth) using the verbatim embedded
    // copies (embeddedMigrations.ts); db/migrations/* remain canonical.
    // Idempotent (IF NOT EXISTS everywhere + tracked Better Auth migrations),
    // so externally-migrated production databases are unaffected.
    // Previously this branch ran only the legacy auth_sessions DDL — which
    // REFERENCES users(id) — before users existed, and returned before
    // creating the Better Auth schema (relation "users" does not exist).
    const { EMBEDDED_001_INITIAL_SCHEMA, EMBEDDED_003_APP_USERS_LINK } = await import('./embeddedMigrations.js');
    await runAllWithVectorFallback(EMBEDDED_001_INITIAL_SCHEMA);
    const { ensureAuthTables } = await import('./auth.js');
    await ensureAuthTables(db);
    await runAll(EMBEDDED_003_APP_USERS_LINK);
    // Better Auth owns its own tables (user/session/account/verification).
    const { ensureBetterAuthSchema } = await import('./betterAuth.js');
    await ensureBetterAuthSchema(db);
    return;
  }
  // Belt-and-braces: if 002 file was missing (older checkout) still ensure
  // the additive auth table exists. 001-only databases remain compatible.
  try {
    const { ensureAuthTables } = await import('./auth.js');
    await ensureAuthTables(db);
  } catch { /* migrate already applied 002; ignore */ }
  // Better Auth owns its own tables (user/session/account/verification).
  // Created programmatically via its Kysely adapter so the DDL always matches
  // the installed better-auth version, on both pg and PGlite.
  const { ensureBetterAuthSchema } = await import('./betterAuth.js');
  await ensureBetterAuthSchema(db);
}

export async function seedDev(db: DbClient): Promise<{ userId: string; workspaceId: string }> {
  const email = 'dev@bhasya.local';
  let user = (await db.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0];
  if (!user) {
    user = (await db.query(`INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, [email, 'Dev User'])).rows[0];
  }
  const userId = (user as any).id as string;
  let ws = (await db.query(`SELECT id FROM workspaces WHERE owner_user_id = $1 LIMIT 1`, [userId])).rows[0];
  if (!ws) {
    ws = (await db.query(`INSERT INTO workspaces (name, owner_user_id) VALUES ($1,$2) RETURNING id`, ['Dev workspace', userId])).rows[0];
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT DO NOTHING`,
      [(ws as any).id, userId],
    );
  }
  return { userId, workspaceId: (ws as any).id as string };
}

export async function logEvent(
  db: DbClient,
  e: { workspaceId?: string; userId?: string; eventType: string; resourceType?: string; resourceId?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO event_log (workspace_id, user_id, event_type, resource_type, resource_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [e.workspaceId ?? null, e.userId ?? null, e.eventType, e.resourceType ?? '', e.resourceId ?? '', JSON.stringify(e.metadata ?? {})],
  );
}

export * from './storage.js';
export * from './queue.js';
export {
  getAuthForDb,
  ensureBetterAuthSchema,
  readBetterAuthEnv,
} from './betterAuth.js';
export {
  getDevIdentity,
  getIdentityForRequest,
  isProductionAuth,
  createAuthSession,
  invalidateSession,
  ensureAuthTables,
  generateSessionToken,
  hashSessionToken,
} from './auth.js';
