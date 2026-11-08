import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect as netConnect, createServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Narrow test-infrastructure fixture for the two heavyweight embedded-Postgres
 * files (`tests/hyperdrive-path.test.ts`, `tests/hyperdrive-lifecycle.test.ts`).
 *
 * Two-tier design (test-infra only, no production/export/timeout changes):
 *
 * 1. Primary: `tests/global-setup.embedded-pg.ts` boots ONE cluster serially
 *    BEFORE workers start (no PGlite contention, ~15s) with per-file
 *    databases (`hdpath`, `hdlifecycle`). `bootEmbeddedPostgres()` reuses it
 *    (zero in-worker initdb cost); stop is a no-op owned by global teardown.
 * 2. Fallback: when no shared cluster exists (e.g. globalSetup bypassed), an
 *    exclusive boot serialized by a cross-process lock around
 *    `initialise()`+`start()` only. Each boot still gets its own isolated
 *    cluster. Client lifecycle unchanged (fresh pg.Client per op, no Pool).
 */

const LOCK_DIR = join(tmpdir(), 'bhasya-embedded-pg-boot.lock.d');
export const sharedFilePath = join(tmpdir(), 'bhasya-test-pg-shared.json');
// Must stay well inside the 60s beforeAll budget: typical boot is ~10-20s, so
// waiting ~one boot (~15s) + own boot (~15s) + probe fits. Fail fast instead of
// hanging past the hook timeout.
const LOCK_WAIT_MS = 40000;
const LOCK_POLL_MS = 100;
const STALE_MS = 120000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireBootLock(prefix: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code !== 'EEXIST') throw e;
      try {
        const st = statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          try {
            rmSync(LOCK_DIR, { recursive: true, force: true });
          } catch { /* ignore, retry */ }
          continue;
        }
      } catch { /* lock vanished, retry */ }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error(
          `[embedded-pg:${prefix}] timed out waiting for boot lock after ${LOCK_WAIT_MS}ms ` +
            `(another embedded-postgres initdb/start in progress)`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseBootLock(): void {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Allocate an ephemeral free TCP port via the OS (bind :0, read back, close).
 * Same mechanism both Hyperdrive files used. `embedded-postgres` cannot
 * discover a `-p 0` port itself, so the caller allocates first.
 */
export async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('failed to allocate a free TCP port for embedded postgres');
  return port;
}

export async function waitForReady(pgUrl: string): Promise<void> {
  // TCP readiness probe after `pg.start()`: the library resolves on the
  // "ready to accept connections" log line, but under parallel-suite load
  // the socket may still refuse the first connect. Poll with a fresh
  // pg.Client (same stateless lifecycle as production) well inside the
  // existing 60s per-test budget — no timeout increase, fail-fast on error.
  const { Client } = await import('pg');
  let lastErr: unknown = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      const probe = new Client({ connectionString: pgUrl });
      await probe.connect();
      try {
        await probe.query('SELECT 1');
      } finally {
        await probe.end();
      }
      return;
    } catch (e) {
      lastErr = e;
      await sleep(100);
    }
  }
  throw new Error(`embedded postgres not ready: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

export type ManagedCluster = {
  initialise: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function pgCtlPath(): string {
  const require = createRequire(import.meta.url);
  const plat = platform();
  const arch = process.arch;
  let pkg: string;
  if (plat === 'win32') pkg = '@embedded-postgres/windows-x64';
  else if (plat === 'darwin') pkg = arch === 'arm64' ? '@embedded-postgres/darwin-arm64' : '@embedded-postgres/darwin-x64';
  else if (plat === 'linux') pkg = arch === 'arm64' ? '@embedded-postgres/linux-arm64' : '@embedded-postgres/linux-x64';
  else throw new Error(`unsupported platform for pg_ctl lookup: ${plat}/${arch}`);
  return join(dirname(require.resolve(`${pkg}/package.json`)), 'native', 'bin', plat === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
}

function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const done = (open: boolean) => {
      try {
        socket.destroy();
      } catch { /* ignore */ }
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

/**
 * Robust cluster shutdown (test-infra only).
 *
 * Why this exists: the library's Windows `stop()` fires a fire-and-forget
 * `taskkill /f /t` and waits for its own `exit` event. Under full-suite load
 * that SIGKILL-style tree kill can strand an orphaned `postgres.exe
 * --forkchild="io_worker"` whose inherited stdio pipes keep the Vitest main
 * process event loop alive (`close timed out after 10000ms`; a live orphan
 * from the full-suite window was observed after teardown). An awaited clean
 * `pg_ctl stop -m fast -w` lets the postmaster reap its children, so no
 * orphans are created. All waits are internally bounded well under Vitest's
 * existing 10s teardown/close budget — no configured timeout is changed.
 */
export async function stopEmbeddedPostgres(opts: {
  pg: ManagedCluster;
  pgDir: string;
  port: number;
  prefix: string;
}): Promise<void> {
  const { pg, pgDir, port, prefix } = opts;
  const s0 = performance.now();
  const child = (pg as unknown as { process?: { exitCode?: number | null } }).process;
  if (child) {
    let cleanStopped = false;
    try {
      await execFileAsync(pgCtlPath(), ['stop', '-D', pgDir, '-m', 'fast', '-w', '-t', '5'], 7000);
      cleanStopped = true;
    } catch { /* fall through to library stop */ }
    if (cleanStopped || child.exitCode !== null) {
      // Postmaster is gone: mark stopped so the library `stop()` returns
      // instantly instead of waiting on an `exit` event that already fired.
      try {
        (pg as unknown as { process?: unknown }).process = undefined;
      } catch { /* ignore */ }
    }
  }
  try {
    await Promise.race([
      pg.stop(),
      sleep(3000).then(() => {
        throw new Error('library stop timed out');
      }),
    ]);
  } catch { /* best-effort; sweep below */ }
  // If the listener is still up (Windows only — other platforms use clean
  // SIGINT shutdown), tree-kill whoever holds our port, awaited.
  if (platform() === 'win32') {
    let open = await isTcpPortOpen(port);
    for (let i = 0; i < 3 && open; i += 1) {
      await sleep(250);
      open = await isTcpPortOpen(port);
    }
    if (open) {
      try {
        const { stdout } = await execFileAsync('netstat', ['-ano'], 5000);
        const pids = new Set<string>();
        for (const line of stdout.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const m = line.trim().match(/(\d+)\s*$/);
            if (m) pids.add(m[1]);
          }
        }
        for (const pid of pids) {
          try {
            await execFileAsync('taskkill', ['/pid', pid, '/f', '/t'], 5000);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    // Reap orphaned forkchild processes of OUR bundled binary whose parent is
    // already dead (healthy trees always have live parents, so concurrent
    // runs are never touched; a foreign postgres uses a different path).
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
        ],
        6000,
      );
      const txt = stdout.trim();
      if (txt) {
        const rows = (
          Array.isArray(JSON.parse(txt)) ? JSON.parse(txt) : [JSON.parse(txt)]
        ) as Array<{ ProcessId: number; ParentProcessId: number; CommandLine?: string }>;
        for (const r of rows) {
          const cmd = String(r.CommandLine ?? '');
          if (!cmd.includes('@embedded-postgres')) continue;
          let parentAlive = true;
          try {
            process.kill(r.ParentProcessId, 0);
          } catch (e: unknown) {
            const code = (e as { code?: string })?.code;
            if (code === 'ESRCH') parentAlive = false;
          }
          if (parentAlive) continue;
          try {
            await execFileAsync('taskkill', ['/pid', String(r.ProcessId), '/f', '/t'], 5000);
            console.log(`[embedded-pg:${prefix}] reaped orphaned postgres pid=${r.ProcessId}`);
          } catch { /* ignore */ }
        }
      }
    } catch { /* best-effort only */ }
  }
  try {
    rmSync(pgDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  console.log(`[embedded-pg:${prefix}] stop+cleanup=${Math.round(performance.now() - s0)}ms`);
}

export async function bootEmbeddedPostgres(prefix: string): Promise<{
  pgUrl: string;
  stop: () => Promise<void>;
}> {
  // Fast path: reuse the globalSetup cluster (booted before workers start, no
  // contention). Each prefix gets its own DATABASE on the shared server, so
  // backend/table isolation is preserved. Stop is a no-op: global teardown
  // owns the lifecycle.
  try {
    const raw = readFileSync(sharedFilePath, 'utf8');
    const data = JSON.parse(raw) as {
      pgUrl?: string;
      hdpathUrl?: string;
      hdlifecycleUrl?: string;
    };
    const url =
      prefix === 'hdpath' ? data.hdpathUrl : prefix === 'hdlifecycle' ? data.hdlifecycleUrl : data.pgUrl;
    if (url) {
      const { Client } = await import('pg');
      const probe = new Client({ connectionString: url });
      await probe.connect();
      try {
        await probe.query('SELECT 1');
      } finally {
        await probe.end();
      }
      console.log(`[embedded-pg:${prefix}] reuse shared ${url}`);
      return {
        pgUrl: url,
        stop: async () => {
          console.log(`[embedded-pg:${prefix}] reuse stop (noop, owned by globalSetup)`);
        },
      };
    }
  } catch { /* no shared cluster, fall through to exclusive boot */ }
  const t00 = performance.now();
  const pgDir = mkdtempSync(join(tmpdir(), `bhasya-${prefix}-`));
  const tMk = performance.now();
  const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as unknown as {
    default: new (opts: Record<string, unknown>) => {
      initialise: () => Promise<void>;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    };
  };
  const tImport = performance.now();
  const port = await getFreePort();
  const tPort = performance.now();
  const pgUrl = `postgres://bhasya:bhasya@127.0.0.1:${port}/postgres`;
  const pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'bhasya',
    password: 'bhasya',
    port,
    persistent: false,
  });
  const tNew = performance.now();

  await acquireBootLock(prefix);
  const tLock = performance.now();
  let booted = false;
  try {
    await pg.initialise();
    const tInit = performance.now();
    await pg.start();
    const tStart = performance.now();
    booted = true;
    console.log(
      `[embedded-pg:${prefix}] mkdtemp=${Math.round(tMk - t00)}ms ` +
        `import=${Math.round(tImport - tMk)}ms port=${Math.round(tPort - tImport)}ms ` +
        `construct=${Math.round(tNew - tPort)}ms lockWait=${Math.round(tLock - tNew)}ms ` +
        `initialise=${Math.round(tInit - tLock)}ms start=${Math.round(tStart - tInit)}ms port=${port}`,
    );
  } finally {
    releaseBootLock();
  }

  const tProbe0 = performance.now();
  try {
    await waitForReady(pgUrl);
  } catch (e) {
    if (booted) {
      try {
        await pg.stop();
      } catch { /* ignore */ }
    }
    try {
      rmSync(pgDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    throw e;
  }
  const tProbe1 = performance.now();
  console.log(
    `[embedded-pg:${prefix}] probe=${Math.round(tProbe1 - tProbe0)}ms ` +
      `total=${Math.round(tProbe1 - t00)}ms url=127.0.0.1:${port}/postgres`,
  );

  return {
    pgUrl,
    stop: async () => {
      await stopEmbeddedPostgres({ pg, pgDir, port, prefix });
    },
  };
}
