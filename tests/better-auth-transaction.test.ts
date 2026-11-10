import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { getAuthForDb, migrate, openDb, type DbClient } from '@bhasya/db';
import { bootEmbeddedPostgres, waitForReady } from './embedded-pg.js';

/**
 * Better Auth transaction proof.
 *
 * The invitation flow will rely on sign-up being atomic: user, account, and
 * session creation must commit together or roll back together. Better Auth
 * only uses a real database transaction when the adapter exposes one, so this
 * file proves the configured Kysely adapter commits and rolls back on both
 * PGlite (dev/test) and real PostgreSQL (the Worker/Hyperdrive shape).
 *
 * Forced failure is a test-only trigger on Better Auth's `session` table. It
 * runs after `user` and `account` inserts, which makes it a precise probe for
 * the rollback of earlier writes in the same transaction.
 *
 * Isolation: PGlite uses `memory://`; PostgreSQL uses a temporary database on
 * the embedded test cluster. `DATABASE_URL` is rejected outright so this file
 * can never touch the developer database, staging, or production.
 */

const inheritedDatabaseUrl = process.env.DATABASE_URL;
if (inheritedDatabaseUrl) {
  throw new Error(
    'better-auth-transaction.test.ts refuses to run with DATABASE_URL set; unset it so only isolated databases are used',
  );
}

const TEST_SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
const BASE_URL = 'http://localhost:8787';
const PASSWORD = 'Password123!';
const FAIL_TABLE = 'bhasya_fail_emails';

const PREV_SECRET = process.env.BETTER_AUTH_SECRET;
const PREV_URL = process.env.BETTER_AUTH_URL;
process.env.BETTER_AUTH_SECRET = TEST_SECRET;
process.env.BETTER_AUTH_URL = BASE_URL;

afterAll(() => {
  if (PREV_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = PREV_SECRET;
  if (PREV_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = PREV_URL;
});

type TestAuth = {
  handler: (request: Request) => Promise<Response>;
};

async function makePglite(): Promise<DbClient> {
  // `databaseUrl: ''` is intentional: openDb resolves DATABASE_URL before
  // dataDir, and this test must never attach to an ambient database.
  return openDb({ databaseUrl: '', dataDir: 'memory://' });
}

async function signUp(auth: TestAuth, email: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Transaction Test' }),
    }),
  );
}

async function countsFor(db: DbClient, email: string): Promise<{ users: number; accounts: number; sessions: number }> {
  const result = await db.query(
    `SELECT
       (SELECT count(*) FROM "user" WHERE email = $1) AS users,
       (SELECT count(*) FROM "account" a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1) AS accounts,
       (SELECT count(*) FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE u.email = $1) AS sessions`,
    [email],
  );
  const row = result.rows[0] as Record<string, unknown>;
  return {
    users: Number(row.users),
    accounts: Number(row.accounts),
    sessions: Number(row.sessions),
  };
}

async function installFailSessionTrigger(db: DbClient): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS ${FAIL_TABLE} (email text PRIMARY KEY)`);
  await db.query(
    `CREATE OR REPLACE FUNCTION bhasya_fail_session_for_email()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$
     BEGIN
       IF EXISTS (
         SELECT 1
         FROM ${FAIL_TABLE} f
         JOIN "user" u ON u.email = f.email
         WHERE u.id = NEW."userId"
       ) THEN
         RAISE EXCEPTION 'forced session failure';
       END IF;
       RETURN NEW;
     END;
     $$`,
  );
  await db.query('DROP TRIGGER IF EXISTS bhasya_fail_session_for_email ON "session"');
  await db.query(
    'CREATE TRIGGER bhasya_fail_session_for_email BEFORE INSERT ON "session" ' +
      'FOR EACH ROW EXECUTE FUNCTION bhasya_fail_session_for_email()',
  );
}

async function dropFailSessionTrigger(db: DbClient): Promise<void> {
  await db.query('DROP TRIGGER IF EXISTS bhasya_fail_session_for_email ON "session"');
  await db.query('DROP FUNCTION IF EXISTS bhasya_fail_session_for_email()');
  await db.query(`DROP TABLE IF EXISTS ${FAIL_TABLE}`);
}

async function markFailEmail(db: DbClient, email: string): Promise<void> {
  await db.query(`INSERT INTO ${FAIL_TABLE} (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
}

async function clearFailEmails(db: DbClient): Promise<void> {
  await db.query(`DELETE FROM ${FAIL_TABLE}`);
}

function capturePgliteTransactions(db: DbClient): { calls: () => number; restore: () => void } {
  const raw = (db as unknown as { pglite: { transaction: (...args: any[]) => any } }).pglite;
  const original = raw.transaction;
  let calls = 0;
  raw.transaction = function patchedPgliteTransaction(this: unknown, ...args: any[]) {
    calls += 1;
    return original.apply(this, args);
  };
  return {
    calls: () => calls,
    restore: () => {
      raw.transaction = original;
    },
  };
}

function capturePgTransactions(): { seen: string[]; reset: () => void; restore: () => void } {
  const proto = Client.prototype as unknown as { query: (...args: any[]) => any };
  const original = proto.query;
  const seen: string[] = [];
  proto.query = function patchedPgQuery(this: unknown, text: any, ...args: any[]) {
    const sql = typeof text === 'string' ? text : text?.text;
    if (typeof sql === 'string') {
      const match = sql.trim().match(/^(begin|commit|rollback)\b/i);
      if (match) seen.push(match[1].toLowerCase());
    }
    return original.apply(this, [text, ...args]);
  };
  return {
    seen,
    reset: () => {
      seen.length = 0;
    },
    restore: () => {
      proto.query = original;
    },
  };
}

describe('Better Auth sign-up transaction (PGlite)', () => {
  let db: DbClient;
  let auth: TestAuth;
  let tx: ReturnType<typeof capturePgliteTransactions>;

  beforeAll(async () => {
    db = await makePglite();
    await migrate(db);
    await installFailSessionTrigger(db);
    tx = capturePgliteTransactions(db);
    auth = await getAuthForDb(db, { env: { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: BASE_URL } });
  });

  afterAll(async () => {
    tx?.restore();
    if (db) {
      await dropFailSessionTrigger(db);
      await db.close?.();
    }
  });

  beforeEach(async () => {
    await clearFailEmails(db);
  });

  afterEach(async () => {
    await clearFailEmails(db);
  });

  it('commits user, account, and session together', async () => {
    const email = 'commit-pglite@bhasya.test';
    const before = tx.calls();
    const res = await signUp(auth, email);
    expect(res.status).toBe(200);
    expect(await countsFor(db, email)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    expect(tx.calls()).toBeGreaterThan(before);
  });

  it('rolls back user, account, and session after forced session failure', async () => {
    const email = 'rollback-pglite@bhasya.test';
    await markFailEmail(db, email);
    const before = tx.calls();
    const res = await signUp(auth, email);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countsFor(db, email)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(tx.calls()).toBeGreaterThan(before);
  });

  it('keeps a failed concurrent sign-up isolated from successful sign-ups', async () => {
    const failed = 'concurrent-failed-pglite@bhasya.test';
    const okA = 'concurrent-ok-a-pglite@bhasya.test';
    const okB = 'concurrent-ok-b-pglite@bhasya.test';
    await markFailEmail(db, failed);
    const before = tx.calls();

    const [failedRes, okARes, okBRes] = await Promise.all([
      signUp(auth, failed),
      signUp(auth, okA),
      signUp(auth, okB),
    ]);

    expect(failedRes.status).toBeGreaterThanOrEqual(400);
    expect(okARes.status).toBe(200);
    expect(okBRes.status).toBe(200);
    expect(await countsFor(db, failed)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(await countsFor(db, okA)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    expect(await countsFor(db, okB)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    expect(tx.calls()).toBeGreaterThanOrEqual(before + 3);
  });
});

describe('Better Auth sign-up transaction (temporary PostgreSQL)', () => {
  let db: DbClient;
  let auth: TestAuth;
  let tx: ReturnType<typeof capturePgTransactions>;
  let stop: () => Promise<void>;
  let baseUrl: string;
  let dbName: string;

  beforeAll(async () => {
    const cluster = await bootEmbeddedPostgres('auth-tx');
    baseUrl = cluster.pgUrl;
    stop = cluster.stop;
    dbName = `auth_tx_${process.pid}_${Date.now()}`;

    const admin = new Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    const dbUrl = url.toString();
    await waitForReady(dbUrl);

    db = await openDb({ databaseUrl: dbUrl, hyperdrive: true });
    await migrate(db);
    await installFailSessionTrigger(db);
    tx = capturePgTransactions();
    auth = await getAuthForDb(db, { env: { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: BASE_URL } });
  });

  afterAll(async () => {
    tx?.restore();
    if (db) {
      await dropFailSessionTrigger(db);
      await db.close?.();
    }
    if (baseUrl && dbName) {
      const admin = new Client({ connectionString: baseUrl });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
    await stop?.();
  });

  beforeEach(async () => {
    await clearFailEmails(db);
    tx.reset();
  });

  afterEach(async () => {
    await clearFailEmails(db);
  });

  it('commits user, account, and session together', async () => {
    const email = 'commit-pg@bhasya.test';
    const res = await signUp(auth, email);
    expect(res.status).toBe(200);
    expect(await countsFor(db, email)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    expect(tx.seen).toContain('begin');
    expect(tx.seen).toContain('commit');
    expect(tx.seen).not.toContain('rollback');
  });

  it('rolls back user, account, and session after forced session failure', async () => {
    const email = 'rollback-pg@bhasya.test';
    await markFailEmail(db, email);
    const res = await signUp(auth, email);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countsFor(db, email)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(tx.seen).toContain('begin');
    expect(tx.seen).toContain('rollback');
    expect(tx.seen).not.toContain('commit');
  });

  it('keeps a failed concurrent sign-up isolated from successful sign-ups', async () => {
    const failed = 'concurrent-failed-pg@bhasya.test';
    const okA = 'concurrent-ok-a-pg@bhasya.test';
    const okB = 'concurrent-ok-b-pg@bhasya.test';
    await markFailEmail(db, failed);

    const [failedRes, okARes, okBRes] = await Promise.all([
      signUp(auth, failed),
      signUp(auth, okA),
      signUp(auth, okB),
    ]);

    expect(failedRes.status).toBeGreaterThanOrEqual(400);
    expect(okARes.status).toBe(200);
    expect(okBRes.status).toBe(200);
    expect(await countsFor(db, failed)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(await countsFor(db, okA)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    expect(await countsFor(db, okB)).toEqual({ users: 1, accounts: 1, sessions: 1 });
    expect(tx.seen.filter((s) => s === 'begin').length).toBeGreaterThanOrEqual(3);
    expect(tx.seen.filter((s) => s === 'commit').length).toBeGreaterThanOrEqual(2);
    expect(tx.seen.filter((s) => s === 'rollback').length).toBeGreaterThanOrEqual(1);
  });
});
