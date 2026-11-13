/**
 * Workerd transaction smoke for Better Auth sign-up.
 *
 * This is the deployment-boundary proof that `transaction: true` survives the
 * real Cloudflare Worker entry, a local Hyperdrive binding, and Better Auth's
 * AsyncLocalStorage path. It is intentionally narrow:
 *
 * - real `wrangler dev --local` (workerd), not Vitest
 * - real PostgreSQL over TCP (embedded-postgres), no pgvector needed
 * - `[[hyperdrive]]` binding with `localConnectionString`, so `getServices`
 *   takes the same Hyperdrive request-scoped path as production
 * - a test-only trigger fails the session insert after user/account inserts;
 *   PostgreSQL's `log_statement=all` proves BEGIN/ROLLBACK vs BEGIN/COMMIT
 *
 * It never uses DATABASE_URL, staging, production, or the developer's local
 * PGlite directory. Run with:
 *
 *   npx tsx scripts/worker-auth-transaction-smoke.ts
 *
 * Exits non-zero on failure and cleans up PostgreSQL + workerd + temp configs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { getFreePort, stopEmbeddedPostgres, waitForReady } from '../tests/embedded-pg.js';

const inheritedDatabaseUrl = process.env.DATABASE_URL;
if (inheritedDatabaseUrl) {
  console.error(
    'FAIL DATABASE_URL is set. This smoke test must use only its isolated embedded PostgreSQL instance.',
  );
  process.exit(1);
}

const API_DIR = fileURLToPath(new URL('../apps/api/', import.meta.url));
const SECRET = 'bhasya-auth-tx-smoke-secret-0123456789abcdef';
const PASSWORD = 'SmokePass123!';
const FAIL_TABLE = 'bhasya_fail_emails';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name: string, condition: unknown) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

function baseToml(opts: { main: string; base: string; pgUrl: string }): string {
  return `name = "bhasya-auth-tx-smoke"
main = "${opts.main}"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
[vars]
BHASYA_USE_AUTH = "1"
BETTER_AUTH_URL = "${opts.base}"
# Local Worker smoke only: enables Better Auth sign-up for this loopback
# instance. Ignored for non-loopback base URLs and always overridden by
# BHASYA_DISABLE_SIGNUP=1.
BHASYA_TEST_SIGNUP = "1"
BHASYA_MODEL_ID = "dev-grounded-1"
BHASYA_MODEL_ENDPOINT = "https://api.openai.com/v1/chat/completions"
[[r2_buckets]]
binding = "BHASYA_BUCKET"
bucket_name = "bhasya-auth-tx-smoke"
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "0123456789abcdef0123456789abcdef"
localConnectionString = "${opts.pgUrl}"
`;
}

type DevServer = { proc: ChildProcess; dir: string; output: () => string };

function wranglerCommand(): { exe: string; prefix: string[] } {
  if (process.platform === 'win32') {
    const entry = resolve(API_DIR, '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    return { exe: process.execPath, prefix: [entry] };
  }
  return { exe: 'npx', prefix: ['wrangler'] };
}

async function bootServer(opts: { base: string; port: number; pgUrl: string }): Promise<DevServer> {
  const dir = mkdtempSync(join(tmpdir(), 'bhasya-auth-tx-wrangler-'));
  const main = join(API_DIR, 'src', 'worker.ts').replaceAll('\\', '/');
  writeFileSync(join(dir, 'wrangler.toml'), baseToml({ main, base: opts.base, pgUrl: opts.pgUrl }));

  const { exe, prefix } = wranglerCommand();
  const proc = spawn(
    exe,
    [
      ...prefix,
      'dev',
      '--local',
      '--port',
      String(opts.port),
      '--config',
      join(dir, 'wrangler.toml'),
      '--var',
      `BETTER_AUTH_SECRET:${SECRET}`,
    ],
    {
      cwd: API_DIR,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    },
  );

  let output = '';
  proc.stdout?.on('data', (chunk) => { output += String(chunk); });
  proc.stderr?.on('data', (chunk) => { output += String(chunk); });
  const spawnError: { error: Error | null } = { error: null };
  proc.on('error', (error) => { spawnError.error = error; });

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (spawnError.error) {
      throw new Error(`failed to launch wrangler dev: ${spawnError.error.message}\n${output.slice(-4000)}`);
    }
    try {
      const response = await fetch(`${opts.base}/healthz`);
      await response.text().catch(() => '');
      return { proc, dir, output: () => output };
    } catch {
      if (proc.exitCode !== null && proc.exitCode !== undefined) {
        throw new Error(`wrangler dev exited (${proc.exitCode}):\n${output.slice(-4000)}`);
      }
      if (Date.now() > deadline) {
        try { proc.kill(); } catch { /* ignore */ }
        throw new Error(`wrangler dev not reachable in 90s:\n${output.slice(-4000)}`);
      }
      await sleep(1000);
    }
  }
}

async function stopServer(server: DevServer | null): Promise<void> {
  if (server) {
    if (server.proc.exitCode === null && server.proc.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolvePromise) => {
          const killer = spawn(
            'taskkill',
            ['/pid', String(server.proc.pid), '/f', '/t'],
            { windowsHide: true, stdio: 'ignore', shell: false },
          );
          killer.once('error', () => resolvePromise());
          killer.once('close', () => resolvePromise());
        });
      } else {
        try { server.proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    try { rmSync(server.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function request(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function withClient<T>(pgUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function installFailSessionTrigger(pgUrl: string): Promise<void> {
  await withClient(pgUrl, async (client) => {
    await client.query(`CREATE TABLE IF NOT EXISTS ${FAIL_TABLE} (email text PRIMARY KEY)`);
    await client.query(
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
    await client.query('DROP TRIGGER IF EXISTS bhasya_fail_session_for_email ON "session"');
    await client.query(
      'CREATE TRIGGER bhasya_fail_session_for_email BEFORE INSERT ON "session" ' +
        'FOR EACH ROW EXECUTE FUNCTION bhasya_fail_session_for_email()',
    );
  });
}

async function markFailEmail(pgUrl: string, email: string): Promise<void> {
  await withClient(pgUrl, async (client) => {
    await client.query(`INSERT INTO ${FAIL_TABLE} (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  });
}

async function clearFailEmails(pgUrl: string): Promise<void> {
  await withClient(pgUrl, async (client) => {
    await client.query(`DELETE FROM ${FAIL_TABLE}`);
  });
}

async function countsFor(pgUrl: string, email: string): Promise<{ users: number; accounts: number; sessions: number }> {
  return withClient(pgUrl, async (client) => {
    const result = await client.query(
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
  });
}

function signUp(base: string, email: string): Promise<{ status: number; body: any }> {
  return request(base, '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: base },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Transaction Smoke' }),
  });
}

async function waitForLog(
  logs: string[],
  predicate: (text: string) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = logs.join('');
    if (predicate(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; recent PostgreSQL log:\n${text.slice(-6000)}`);
    }
    await sleep(100);
  }
}

async function resetLogs(logs: string[]): Promise<void> {
  logs.length = 0;
  // Let any in-flight log chunks from the previous setup/query flush.
  await sleep(300);
}

function transactionCounts(text: string): { begin: number; commit: number; rollback: number } {
  return {
    begin: text.match(/statement:\s*begin/gi)?.length ?? 0,
    commit: text.match(/statement:\s*commit/gi)?.length ?? 0,
    rollback: text.match(/statement:\s*rollback/gi)?.length ?? 0,
  };
}

const pgDir = mkdtempSync(join(tmpdir(), 'bhasya-auth-tx-pg-'));
const pgPort = await getFreePort();
const pgUrl = `postgres://bhasya:bhasya@127.0.0.1:${pgPort}/postgres`;
const pgLogs: string[] = [];
const pg = new EmbeddedPostgres({
  databaseDir: pgDir,
  user: 'bhasya',
  password: 'bhasya',
  port: pgPort,
  persistent: false,
  postgresFlags: ['-c', 'log_statement=all'],
  onLog: (message) => { pgLogs.push(String(message)); },
});

let server: DevServer | null = null;
let httpPort = 0;
let base = '';

try {
  await pg.initialise();
  await pg.start();
  await waitForReady(pgUrl);
  check('[1] isolated embedded PostgreSQL started', true);

  httpPort = await getFreePort();
  base = `http://127.0.0.1:${httpPort}`;
  server = await bootServer({ base, port: httpPort, pgUrl });

  const health = await request(base, '/healthz');
  if (health.status !== 200) {
    throw new Error(
      `worker health failed (${health.status}): ${JSON.stringify(health.body)}\n${server.output().slice(-6000)}`,
    );
  }
  check('[2] /healthz 200 through workerd with Hyperdrive binding', health.body?.ok === true);

  await installFailSessionTrigger(pgUrl);

  // ── Forced rollback: user + account insert, session insert fails ──
  const rollbackEmail = 'rollback-worker@bhasya.test';
  await markFailEmail(pgUrl, rollbackEmail);
  await resetLogs(pgLogs);
  const rollback = await signUp(base, rollbackEmail);
  check('[3] forced-failure sign-up returns an error', rollback.status >= 400);
  const rollbackCounts = await countsFor(pgUrl, rollbackEmail);
  console.log(`rollback counts: ${JSON.stringify(rollbackCounts)}`);
  check(
    '[4] rollback left no user/account/session',
    JSON.stringify(rollbackCounts) === JSON.stringify({ users: 0, accounts: 0, sessions: 0 }),
  );
  const rollbackLog = await waitForLog(
    pgLogs,
    (text) => /statement:\s*begin/i.test(text) && /statement:\s*rollback/i.test(text),
    'BEGIN + ROLLBACK',
  );
  const rollbackTx = transactionCounts(rollbackLog);
  console.log(`rollback transaction log: ${JSON.stringify(rollbackTx)}`);
  check('[5] PostgreSQL saw BEGIN + ROLLBACK', rollbackTx.begin >= 1 && rollbackTx.rollback >= 1);

  // ── Commit: the same path without the forced trigger ──
  await clearFailEmails(pgUrl);
  await resetLogs(pgLogs);
  const commitEmail = 'commit-worker@bhasya.test';
  const commit = await signUp(base, commitEmail);
  check('[6] successful sign-up returns 200', commit.status === 200);
  const commitLog = await waitForLog(
    pgLogs,
    (text) => /statement:\s*begin/i.test(text) && /statement:\s*commit/i.test(text),
    'BEGIN + COMMIT',
  );
  const commitTx = transactionCounts(commitLog);
  console.log(`commit transaction log: ${JSON.stringify(commitTx)}`);
  check('[7] PostgreSQL saw BEGIN + COMMIT', commitTx.begin >= 1 && commitTx.commit >= 1);
  check(
    '[8] commit persisted user/account/session',
    JSON.stringify(await countsFor(pgUrl, commitEmail)) === JSON.stringify({ users: 1, accounts: 1, sessions: 1 }),
  );

  // ── Concurrency: one failing sign-up must not affect two successful ones ──
  const failed = 'concurrent-failed-worker@bhasya.test';
  const okA = 'concurrent-ok-a-worker@bhasya.test';
  const okB = 'concurrent-ok-b-worker@bhasya.test';
  await markFailEmail(pgUrl, failed);
  await resetLogs(pgLogs);
  const [failedRes, okARes, okBRes] = await Promise.all([
    signUp(base, failed),
    signUp(base, okA),
    signUp(base, okB),
  ]);
  check('[9] concurrent failing sign-up returns an error', failedRes.status >= 400);
  check('[10] concurrent successful sign-ups return 200', okARes.status === 200 && okBRes.status === 200);
  const concurrentLog = await waitForLog(
    pgLogs,
    (text) => {
      const counts = transactionCounts(text);
      return counts.begin >= 3 && counts.commit >= 2 && counts.rollback >= 1;
    },
    'three BEGINs, two COMMITs, one ROLLBACK',
  );
  const concurrentTx = transactionCounts(concurrentLog);
  console.log(`concurrent transaction log: ${JSON.stringify(concurrentTx)}`);
  check(
    '[11] concurrent transactions committed and rolled back independently',
    concurrentTx.begin >= 3 && concurrentTx.commit >= 2 && concurrentTx.rollback >= 1,
  );
  check(
    '[12] failed concurrent sign-up left no rows',
    JSON.stringify(await countsFor(pgUrl, failed)) === JSON.stringify({ users: 0, accounts: 0, sessions: 0 }),
  );
  check(
    '[13] successful concurrent sign-ups each have one row set',
    JSON.stringify(await countsFor(pgUrl, okA)) === JSON.stringify({ users: 1, accounts: 1, sessions: 1 }) &&
      JSON.stringify(await countsFor(pgUrl, okB)) === JSON.stringify({ users: 1, accounts: 1, sessions: 1 }),
  );

  const output = server.output();
  check(
    '[14] workerd did not warn that AsyncLocalStorage is unavailable',
    !/AsyncLocalStorage is not available/i.test(output) && !/Some features may not work as expected/i.test(output),
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (server) console.error(`--- workerd output ---\n${server.output().slice(-12000)}`);
  failures += 1;
} finally {
  await stopServer(server);
  try {
    await stopEmbeddedPostgres({ pg, pgDir, port: pgPort, prefix: 'auth-tx-worker' });
  } catch {
    try { await pg.stop(); } catch { /* ignore */ }
    try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(failures === 0 ? '\nWORKER AUTH TRANSACTION SMOKE COMPLETE' : `\nWORKER AUTH TRANSACTION SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
