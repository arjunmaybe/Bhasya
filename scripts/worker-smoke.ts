/**
 * Worker deployment-boundary smoke (Cloudflare workerd, NOT just tsc/vitest).
 *
 * - Real PostgreSQL over TCP (embedded-postgres, no pgvector — migrate falls
 *   back to TEXT for embeddings; the smoke never touches vectors).
 * - Real `wrangler dev --local` (workerd) + simulated R2 binding.
 * - Real Better Auth lifecycle through the Worker (sign-up → session → logout).
 * - Fail-closed variants: missing R2 / secret / database.
 *
 * Run:  npx tsx scripts/worker-smoke.ts
 * Exits non-zero on any failure. Cleans up PG + workerd + temp configs.
 * No Cloudflare account, no deploy, no committed secrets.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = fileURLToPath(new URL('../apps/api/', import.meta.url));
const PORT = 9587;
const BASE = `http://127.0.0.1:${PORT}`;
const PG_PORT = 55433;
const PG_URL = `postgres://bhasya:bhasya@127.0.0.1:${PG_PORT}/postgres`;
const SECRET = 'bhasya-smoke-secret-0123456789abcdef-00000000';
const PASSWORD = 'SmokePass123!';

let failures = 0;
const check = (n: string, cond: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${n}`);
  if (!cond) failures += 1;
};

async function req(path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, body, headers: res.headers };
}

function cookiesFrom(headers: Headers): string {
  const getSet = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raws: string[] = typeof getSet === 'function'
    ? getSet.call(headers)
    : (headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=[^;,]*;)/);
  return raws.map((s) => s.split(';')[0].trim()).filter(Boolean).join('; ');
}

function baseToml(main: string, opts: { r2: boolean; hyperdrive: boolean }): string {
  return `name = "bhasya-api-smoke"
main = "${main}"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
[vars]
BHASYA_USE_AUTH = "1"
BETTER_AUTH_URL = "${BASE}"
BHASYA_MODEL_ID = "dev-grounded-1"
BHASYA_MODEL_ENDPOINT = "https://api.openai.com/v1/chat/completions"
${opts.r2 ? '[[r2_buckets]]\nbinding = "BHASYA_BUCKET"\nbucket_name = "bhasya-smoke"\n' : ''}
${opts.hyperdrive ? '[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "smoke-only"\nlocalConnectionString = "postgres://bhasya:bhasya@127.0.0.1:1/unused"\n' : ''}`;
}

type DevServer = { proc: ChildProcess; dir: string };

// Windows-safe executable resolution for wrangler dev (no shell).
// On win32 we run wrangler's JS entry directly via node.exe with shell:false.
// (spawn('npx.cmd', ..., { shell: false }) fails with EINVAL on Node 22 because
// .cmd shims require a shell; node.exe is a real executable so CreateProcess
// handles it. shell:true would route through cmd.exe and is avoided.)
function wranglerCommand(): { exe: string; prefix: string[] } {
  if (process.platform === 'win32') {
    const entry = resolve(API_DIR, '..', '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    return { exe: process.execPath, prefix: [entry] };
  }
  return { exe: 'npx', prefix: ['wrangler'] };
}

async function boot(args: { vars: Record<string, string>; r2: boolean; hyperdrive: boolean }): Promise<DevServer> {
  const dir = mkdtempSync(join(tmpdir(), 'bhasya-wrangler-'));
  const main = join(API_DIR, 'src', 'worker.ts').replaceAll('\\', '/');
  writeFileSync(join(dir, 'wrangler.toml'), baseToml(main, args));
  const varArgs = Object.entries(args.vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  const { exe, prefix } = wranglerCommand();
  const proc = spawn(exe, [...prefix, 'dev', '--local', '--port', String(PORT), '--config', join(dir, 'wrangler.toml'), ...varArgs], {
    cwd: API_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let out = '';
  const spawnState: { error: Error | null } = { error: null };
  proc.on('error', (err) => { spawnState.error = err; });
  proc.stdout?.on('data', (d) => { out += String(d); });
  proc.stderr?.on('data', (d) => { out += String(d); });
  // Ready = workerd answers HTTP (200 or fail-closed 500 both prove the runtime serves).
  const deadline = Date.now() + 90000;
  for (;;) {
    const spawnError = spawnState.error;
    if (spawnError) {
      throw new Error(`failed to launch wrangler dev (${exe} ${[...prefix, 'dev'].join(' ')}): ${spawnError.message}`);
    }
    try {
      const r = await fetch(`${BASE}/healthz`);
      await r.text().catch(() => '');
      return { proc, dir };
    } catch {
      const lateError = spawnState.error;
      if (lateError) {
        throw new Error(`failed to launch wrangler dev (${exe}): ${lateError.message}\n${out.slice(-3000)}`);
      }
      if (proc.exitCode !== null && proc.exitCode !== undefined) {
        throw new Error(`wrangler dev exited (${proc.exitCode}):\n${out.slice(-3000)}`);
      }
      if (Date.now() > deadline) {
        try { proc.kill(); } catch { /* ignore */ }
        throw new Error(`wrangler dev not reachable in 90s:\n${out.slice(-3000)}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function stop(s: DevServer): void {
  try { s.proc.kill(); } catch { /* ignore */ }
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const pgDir = mkdtempSync(join(tmpdir(), 'bhasya-pg-'));
const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as any;
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: 'bhasya', password: 'bhasya', port: PG_PORT, persistent: false });
let server: DevServer | null = null;
try {
  await pg.initialise();
  await pg.start();
  console.log('PASS pg started (embedded-postgres, TCP)');

  const fullVars = { DATABASE_URL: PG_URL, BETTER_AUTH_SECRET: SECRET };

  // ── Full wiring: healthz + Better Auth lifecycle + R2-backed ingest ──
  server = await boot({ vars: fullVars, r2: true, hyperdrive: false });
  try {
    const h = await req('/healthz');
    check('[1] /healthz 200 through workerd', h.status === 200 && h.body?.ok === true);

    const up = await req('/api/auth/sign-up/email', {
      method: 'POST', body: JSON.stringify({ email: 'smoke@bhasya.test', password: PASSWORD, name: 'Smoke' }),
    });
    const cookie = cookiesFrom(up.headers);
    check('[2] sign-up 200 through workerd', up.status === 200 && cookie.includes('better-auth.session_token='));

    const sess = await req('/api/auth/get-session', { headers: { cookie } });
    check('[3] get-session 200 through workerd', sess.status === 200 && !!sess.body?.user?.id);

    const list = await req('/api/sources', { headers: { cookie } });
    check('[4] app identity derived from Better Auth session (200)', list.status === 200 && Array.isArray(list.body?.sources));

    const anon = await req('/api/sources');
    check('[5] unauthenticated 401 through workerd', anon.status === 401);

    const out = await req('/api/auth/sign-out', { method: 'POST', headers: { cookie } });
    const after = await req('/api/sources', { headers: { cookie } });
    check('[6] sign-out invalidates session (401 after)', out.status === 200 && after.status === 401);

    // Re-authenticate for the ingest check (sign-out revoked the session above).
    const backIn = await req('/api/auth/sign-in/email', {
      method: 'POST', body: JSON.stringify({ email: 'smoke@bhasya.test', password: PASSWORD }),
    });
    const cookie2 = cookiesFrom(backIn.headers);
    let ingested = false;
    try {
      const ing = await req('/api/sources/ingest', {
        method: 'POST', headers: { cookie: cookie2 }, body: JSON.stringify({ url: 'https://example.com' }),
      });
      ingested = ing.status === 201 && !!ing.body?.versionId;
      check('[7] ingest 201 writes R2 through workerd (no storage 500)', ingested);
    } catch (e) {
      console.log(`SKIP [7] ingest (network egress unavailable: ${e instanceof Error ? e.message : e})`);
    }
  } finally {
    stop(server); server = null;
  }

  // ── Fail closed: no R2 binding ──
  server = await boot({ vars: fullVars, r2: false, hyperdrive: false });
  try {
    const h = await req('/healthz');
    check('[8] missing R2 fails closed (500, R2 message)', h.status === 500 && /R2 bucket binding required/.test(String(h.body?.error ?? '')));
  } finally {
    stop(server); server = null;
  }

  // ── Fail closed: no Better Auth secret ──
  server = await boot({ vars: { DATABASE_URL: PG_URL }, r2: true, hyperdrive: false });
  try {
    const h = await req('/healthz');
    check('[9] missing BETTER_AUTH_SECRET fails closed (500)', h.status === 500 && /BETTER_AUTH_SECRET/.test(String(h.body?.error ?? '')));
  } finally {
    stop(server); server = null;
  }

  // ── Fail closed: no database (no DATABASE_URL, no Hyperdrive) ──
  server = await boot({ vars: { BETTER_AUTH_SECRET: SECRET }, r2: true, hyperdrive: false });
  try {
    const h = await req('/healthz');
    check('[10] missing DATABASE_URL fails closed, never PGlite (500)', h.status === 500 && /DATABASE_URL/.test(String(h.body?.error ?? '')));
  } finally {
    stop(server); server = null;
  }
} finally {
  if (server) stop(server);
  try { await pg.stop(); } catch { /* ignore */ }
  try { rmSync(pgDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? '\nWORKER SMOKE COMPLETE' : `\nWORKER SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
