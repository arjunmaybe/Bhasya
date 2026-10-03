/**
 * Staging/production database migration (NO seed).
 *
 * Applies the canonical migrations (db/migrations/*) plus the Better Auth
 * schema to the REAL PostgreSQL/pgvector database, then prints a verification
 * readout (extensions, tables, app-user link column). Never seeds the local
 * dev identity — `dev@bhasya.local` must never exist outside local dev
 * (use scripts/migrate.ts for the local loop, which migrates + seeds).
 *
 * Usage (credentials via environment only, never committed):
 *   DATABASE_URL=postgres://USER:PASS@HOST:5432/DB npx tsx scripts/migrate-staging.ts
 *   npm run db:migrate:staging   # same, reads DATABASE_URL from the environment
 *
 * Fails closed without DATABASE_URL (never touches the PGlite dev adapter).
 * Exits non-zero if any expected extension/table/column is missing.
 * Safe to re-run (all DDL is IF NOT EXISTS / tracked migrations).
 */
import { migrate, openDb } from '@bhasya/db';

const APP_TABLES = [
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
// Better Auth owns these (created via its Kysely adapter in migrate()).
// Listed for the readout; Better Auth remains authoritative for its schema.
const AUTH_TABLES = ['user', 'session', 'account', 'verification'];

const rawUrl = process.env['DATABASE_URL'];
const url = rawUrl?.trim();
if (!url) {
  console.error('DATABASE_URL is required (staging/production PostgreSQL/pgvector). Refusing to touch the PGlite dev adapter.');
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//i.test(url)) {
  console.error('DATABASE_URL must be a postgres:// (or postgresql://) connection string. Refusing to run against an unexpected target.');
  process.exit(2);
}

const db = await openDb({ databaseUrl: url });
try {
  await migrate(db);

  const ext = await db.query(
    `SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','vector')`,
  );
  const foundExt = new Set(ext.rows.map((r) => String((r as Record<string, unknown>)['extname'])));

  const tbl = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const foundTbl = new Set(tbl.rows.map((r) => String((r as Record<string, unknown>)['tablename'])));

  const col = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'external_user_id'`,
  );

  const missingExt = ['pgcrypto', 'vector'].filter((e) => !foundExt.has(e));
  const missingApp = APP_TABLES.filter((t) => !foundTbl.has(t));
  const presentAuth = AUTH_TABLES.filter((t) => foundTbl.has(t));
  const missingAuth = AUTH_TABLES.filter((t) => !foundTbl.has(t));
  const hasLink = col.rows.length > 0;

  console.log(JSON.stringify({
    extensions: [...foundExt],
    appTablesPresent: APP_TABLES.filter((t) => foundTbl.has(t)).length,
    appTablesTotal: APP_TABLES.length,
    authTablesPresent: presentAuth,
    usersExternalUserId: hasLink,
  }, null, 2));

  const problems: string[] = [];
  if (missingExt.length > 0) problems.push(`missing extensions: ${missingExt.join(', ')} (staging PostgreSQL needs pgcrypto + pgvector)`);
  if (missingApp.length > 0) problems.push(`missing app tables: ${missingApp.join(', ')}`);
  if (missingAuth.length > 0) problems.push(`missing Better Auth tables: ${missingAuth.join(', ')}`);
  if (!hasLink) problems.push('missing users.external_user_id column (003 app-user link)');
  if (problems.length > 0) {
    for (const p of problems) console.error(`STAGING CHECK FAILED: ${p}`);
    process.exit(1);
  }
  console.log('STAGING MIGRATION COMPLETE');
} finally {
  await db.close?.();
}
