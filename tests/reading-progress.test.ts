import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { DevGroundedAdapter, ModelRouter } from '@bhasya/ai';
import { MemoryStorageAdapter, migrate, openDb, splitStatements, type DbClient } from '@bhasya/db';
import { createApp } from '../apps/api/src/app.js';
import { getReadingProgress, saveReadingProgress } from '../apps/api/src/reading-progress.js';
import { ingestSource, setServices, type Services } from '../apps/api/src/services.js';
import { createProgressSaver } from '../apps/web/lib/progress-save.js';
import { EMBEDDED_005_READING_PROGRESS } from '../packages/db/src/embeddedMigrations.js';
import { ingestSample, makeServices, mockFetch, publicDns, SAMPLE_HTML } from './helpers.js';

/**
 * Reader progress migration + API.
 *
 * Covers the additive 005 migration (file, embedded Worker mirror, fast-path
 * registration), authenticated GET/PUT behavior, strict payload validation,
 * cross-version passage rejection, no-store on every response, the
 * per-reader-instance ordering guard, and per-user isolation between two
 * authenticated users who share one workspace.
 */

const migrationFile = () =>
  readFileSync(join(process.cwd(), 'db', 'migrations', '005_reading_progress.sql'), 'utf8');
const normalizeEol = (value: string) => value.replace(/\r\n/g, '\n');

const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

function progressBody(
  passageId: string,
  offsetRatio: number,
  sequence: number,
  instanceId = INSTANCE_A,
): Record<string, unknown> {
  return { passageId, offsetRatio, instanceId, sequence };
}

async function tableExists(db: DbClient, name: string): Promise<boolean> {
  const rows = (await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [name],
  )).rows;
  return rows.length > 0;
}

async function passageIds(db: DbClient, versionId: string): Promise<string[]> {
  const rows = (await db.query(
    `SELECT id FROM passages WHERE document_version_id = $1 ORDER BY structural_path, ordinal`, [versionId],
  )).rows;
  return rows.map((row) => String((row as Record<string, unknown>)['id']));
}

/** Second app user, member of the SAME workspace as `identity`. */
async function addWorkspacePeer(
  svc: Services,
  workspaceId: string,
  email: string,
): Promise<{ userId: string; workspaceId: string; email: string }> {
  const user = (await svc.db.query(
    `INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, [email, 'Peer'],
  )).rows[0] as Record<string, unknown>;
  const userId = String(user['id']);
  await svc.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member')`,
    [workspaceId, userId],
  );
  return { userId, workspaceId, email };
}

/** App user with their OWN workspace (no membership in `workspaceId`). */
async function addOutsider(
  svc: Services,
  email: string,
): Promise<{ userId: string; workspaceId: string; email: string }> {
  const user = (await svc.db.query(
    `INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id`, [email, 'Outsider'],
  )).rows[0] as Record<string, unknown>;
  const userId = String(user['id']);
  const workspace = (await svc.db.query(
    `INSERT INTO workspaces (name, owner_user_id) VALUES ($1,$2) RETURNING id`, ['Elsewhere', userId],
  )).rows[0] as Record<string, unknown>;
  const workspaceId = String(workspace['id']);
  await svc.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')`,
    [workspaceId, userId],
  );
  return { userId, workspaceId, email };
}

interface Held {
  promise: Promise<void>;
  resolve: () => void;
}

function held(): Held {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

const PREV_AUTH = process.env.BHASYA_USE_AUTH;
const PREV_SECRET = process.env.BETTER_AUTH_SECRET;
const PREV_URL = process.env.BETTER_AUTH_URL;
const TEST_SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';

afterEach(() => {
  if (PREV_AUTH === undefined) delete process.env.BHASYA_USE_AUTH;
  else process.env.BHASYA_USE_AUTH = PREV_AUTH;
  if (PREV_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = PREV_SECRET;
  if (PREV_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = PREV_URL;
  setServices(null);
});

describe('migration 005: reader progress', () => {
  it('ships an additive migration mirrored byte-for-byte in the Worker bundle', () => {
    const sql = migrationFile();
    expect(normalizeEol(EMBEDDED_005_READING_PROGRESS)).toBe(`\n${normalizeEol(sql)}`);
    // Additive only: a new table, no canonical-model changes.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS reading_progress/);
    expect(sql).not.toMatch(/ALTER TABLE\s+(?!reading_progress)/i);
    expect(sql).not.toMatch(/DROP /i);
  });

  it('creates the per-user resume table with a composite key, ratio bound, and ordering guard', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      await migrate(db);
      expect(await tableExists(db, 'reading_progress')).toBe(true);

      const columns = (await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'reading_progress'`,
      )).rows.map((row) => String((row as Record<string, unknown>)['column_name']));
      expect(columns.sort()).toEqual([
        'document_version_id',
        'offset_ratio',
        'passage_id',
        'updated_at',
        'user_id',
        'writer_instance_id',
        'writer_sequence',
      ]);
      // Workspace is derived through document_versions -> sources; never stored.
      expect(columns).not.toContain('workspace_id');

      const primary = (await db.query(
        `SELECT a.attname AS name
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'reading_progress'::regclass AND i.indisprimary`,
      )).rows.map((row) => String((row as Record<string, unknown>)['name'])).sort();
      expect(primary).toEqual(['document_version_id', 'user_id']);

      const checks = (await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'reading_progress'::regclass AND contype = 'c'`,
      )).rows.map((row) => String((row as Record<string, unknown>)['def'])).join(' ');
      expect(checks).toMatch(/offset_ratio/);
      expect(checks).toMatch(/writer_sequence/);
    } finally {
      await db.close?.();
    }
  });

  it('fast path is not fooled by a database missing reading_progress', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      await migrate(db);
      await db.query(`DROP TABLE reading_progress`);
      expect(await tableExists(db, 'reading_progress')).toBe(false);

      // MIGRATED_APP_TABLES must include the new table, otherwise the fast
      // path would declare this database current and 005 would never run.
      await migrate(db);
      expect(await tableExists(db, 'reading_progress')).toBe(true);
    } finally {
      await db.close?.();
    }
  });

  it('embedded Worker replay is executable and idempotent without files', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    try {
      await migrate(db);
      await db.query(`DROP TABLE reading_progress`);

      for (const statement of splitStatements(EMBEDDED_005_READING_PROGRESS)) {
        await db.query(statement);
      }
      expect(await tableExists(db, 'reading_progress')).toBe(true);

      // Re-running must be a no-op (cold-start safety).
      for (const statement of splitStatements(EMBEDDED_005_READING_PROGRESS)) {
        await db.query(statement);
      }
      expect(await tableExists(db, 'reading_progress')).toBe(true);
    } finally {
      await db.close?.();
    }
  });

  it('is registered in the migration order, fast path, Worker replay, and staging check', () => {
    const dbSource = readFileSync(join(process.cwd(), 'packages', 'db', 'src', 'index.ts'), 'utf8');
    const workerBranchStart = dbSource.indexOf('No migration files available');
    expect(workerBranchStart).toBeGreaterThan(0);
    const workerBranch = dbSource.slice(
      workerBranchStart,
      dbSource.indexOf('Better Auth owns its own tables', workerBranchStart),
    );
    expect(dbSource).toContain(`'005_reading_progress.sql'`);
    expect(workerBranch).toContain('EMBEDDED_005_READING_PROGRESS');
    expect(workerBranch).toMatch(/runAll\(EMBEDDED_005_READING_PROGRESS\)/);
    // 005 must run after 004: exports must not be skipped in the Worker bundle.
    expect(workerBranch.indexOf('runAll(EMBEDDED_004_EXPORTS)'))
      .toBeLessThan(workerBranch.indexOf('runAll(EMBEDDED_005_READING_PROGRESS)'));

    const fastPath = dbSource.slice(
      dbSource.indexOf('const MIGRATED_APP_TABLES = ['),
      dbSource.indexOf('const MIGRATED_AUTH_TABLES'),
    );
    expect(fastPath).toMatch(/'reading_progress',/);

    const staging = readFileSync(join(process.cwd(), 'scripts', 'migrate-staging.ts'), 'utf8');
    expect(staging).toMatch(/'reading_progress',/);
  });
});

describe('reader progress API: authentication', () => {
  it('rejects unauthenticated reads and writes with no-store', async () => {
    process.env.BHASYA_USE_AUTH = '1';
    process.env.BETTER_AUTH_SECRET = TEST_SECRET;
    process.env.BETTER_AUTH_URL = 'http://localhost';

    const { svc, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const path = '/api/documents/00000000-0000-4000-8000-000000000000/progress';

      const read = await app.request(path);
      expect(read.status).toBe(401);
      expect(read.headers.get('cache-control')).toBe('no-store');
      expect(((await read.json()) as any).error).toBe('unauthenticated');

      const write = await app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(progressBody('00000000-0000-4000-8000-000000000001', 0.5, 1)),
      });
      expect(write.status).toBe(401);
      expect(write.headers.get('cache-control')).toBe('no-store');
    } finally {
      await cleanup();
    }
  });
});

describe('reader progress API: payload validation', () => {
  it('rejects malformed bodies and out-of-range ratios without writing', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [passageId] = await passageIds(svc.db, versionId);
      setServices(svc);
      const app = createApp();
      const path = `/api/documents/${versionId}/progress`;

      const invalid: Array<{ label: string; body: string }> = [
        { label: 'malformed json', body: 'not-json' },
        { label: 'empty object', body: '{}' },
        { label: 'ratio above 1', body: JSON.stringify(progressBody(passageId, 1.5, 1)) },
        { label: 'negative ratio', body: JSON.stringify(progressBody(passageId, -0.1, 1)) },
        { label: 'string ratio', body: JSON.stringify({ ...progressBody(passageId, 0.5, 1), offsetRatio: '0.5' }) },
        { label: 'non-uuid passage', body: JSON.stringify(progressBody('not-a-uuid', 0.4, 1)) },
        { label: 'missing instance', body: JSON.stringify({ passageId, offsetRatio: 0.4, sequence: 1 }) },
        { label: 'missing sequence', body: JSON.stringify({ passageId, offsetRatio: 0.4, instanceId: INSTANCE_A }) },
        { label: 'non-uuid instance', body: JSON.stringify(progressBody(passageId, 0.4, 1, 'tab-1')) },
        { label: 'fractional sequence', body: JSON.stringify(progressBody(passageId, 0.4, 1.5)) },
        { label: 'negative sequence', body: JSON.stringify(progressBody(passageId, 0.4, -1)) },
        { label: 'extra selector', body: JSON.stringify({ ...progressBody(passageId, 0.4, 1), userId: 'attacker' }) },
      ];

      for (const item of invalid) {
        const res = await app.request(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: item.body,
        });
        expect(res.status, item.label).toBe(400);
        expect(res.headers.get('cache-control'), item.label).toBe('no-store');
      }

      const rows = (await svc.db.query(`SELECT count(*)::int AS n FROM reading_progress`)).rows[0] as any;
      expect(Number(rows.n)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('returns no-store for a 404 on an unknown document version', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const res = await app.request('/api/documents/00000000-0000-4000-8000-0000000000ff/progress');
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      await cleanup();
    }
  });
});

describe('reader progress API: save and load', () => {
  it('round-trips a position with no-store headers', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [firstPassage] = await passageIds(svc.db, versionId);
      setServices(svc);
      const app = createApp();
      const path = `/api/documents/${versionId}/progress`;

      const empty = await app.request(path);
      expect(empty.status).toBe(200);
      expect(empty.headers.get('cache-control')).toBe('no-store');
      expect(((await empty.json()) as any).progress).toBeNull();

      const put = await app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(progressBody(firstPassage, 0.42, 1)),
      });
      expect(put.status).toBe(200);
      expect(put.headers.get('cache-control')).toBe('no-store');
      const saved = ((await put.json()) as any).progress;
      expect(saved.passageId).toBe(firstPassage);
      expect(saved.offsetRatio).toBeCloseTo(0.42, 6);
      expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false);

      const read = await app.request(path);
      expect(read.status).toBe(200);
      const progress = ((await read.json()) as any).progress;
      expect(progress.passageId).toBe(firstPassage);
      expect(progress.offsetRatio).toBeCloseTo(0.42, 6);

      // Overwrite is an upsert on (document_version_id, user_id).
      const secondPassage = (await passageIds(svc.db, versionId))[1];
      await app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(progressBody(secondPassage, 0, 2)),
      });
      const rows = (await svc.db.query(
        `SELECT passage_id, offset_ratio FROM reading_progress WHERE document_version_id = $1 AND user_id = $2`,
        [versionId, identity.userId],
      )).rows;
      expect(rows.length).toBe(1);
      expect(String((rows[0] as any).passage_id)).toBe(secondPassage);
    } finally {
      await cleanup();
    }
  });

  it('ignores a late older write from the same reader instance', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [first, second] = await passageIds(svc.db, versionId);
      setServices(svc);
      const app = createApp();
      const path = `/api/documents/${versionId}/progress`;
      const put = (body: Record<string, unknown>) => app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Newer position lands first (a normal request resolved early).
      const newer = await put(progressBody(second, 0.6, 10));
      expect(newer.status).toBe(200);
      expect(((await newer.json()) as any).progress.passageId).toBe(second);

      // The older request completes last (pagehide keepalive arrived late).
      const late = await put(progressBody(first, 0.2, 9));
      expect(late.status).toBe(200);
      // Rejected by the guard: the response reports the authoritative row.
      expect(((await late.json()) as any).progress.passageId).toBe(second);

      const read = await app.request(path);
      const progress = ((await read.json()) as any).progress;
      expect(progress.passageId).toBe(second);
      expect(progress.offsetRatio).toBeCloseTo(0.6, 6);
    } finally {
      await cleanup();
    }
  });

  it('stores the newer position when a normal request and a keepalive save complete in reverse order', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [first, second] = await passageIds(svc.db, versionId);

      // The real service is the transport, so the per-instance ordering guard
      // is exercised rather than simulated.
      const gates = [held(), held()];
      const finished = [held(), held()];
      const dispatched: number[] = [];
      const saver = createProgressSaver(async (payload, options) => {
        const index = options.sequence - 1;
        dispatched.push(options.sequence);
        await gates[index].promise;
        await saveReadingProgress(svc, identity, versionId, {
          passageId: payload.passageId,
          offsetRatio: payload.offsetRatio,
          instanceId: options.instanceId,
          sequence: options.sequence,
        });
        finished[index].resolve();
      }, { instanceId: INSTANCE_A });

      // 1) A normal request begins.
      const normal = saver.save({ passageId: first, offsetRatio: 0.1 });
      // 2) A newer keepalive request is dispatched while it is in flight.
      const keepalive = saver.save({ passageId: second, offsetRatio: 0.9 }, { keepalive: true });
      expect(dispatched).toEqual([1, 2]);

      // 3) Responses complete in reverse order: newer commits first, then the
      //    older request lands last.
      gates[1].resolve();
      await finished[1].promise;
      gates[0].resolve();
      await finished[0].promise;
      await Promise.all([normal, keepalive]);

      // 4) The final stored position is the newer one.
      const stored = await getReadingProgress(svc, identity, versionId);
      expect(stored?.passageId).toBe(second);
      expect(stored?.offsetRatio).toBeCloseTo(0.9, 6);
      saver.dispose();
    } finally {
      await cleanup();
    }
  });

  it('persists an identical keepalive position while the normal write is in flight', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [, second] = await passageIds(svc.db, versionId);
      const position = { passageId: second, offsetRatio: 0.4 };

      const gate = held();
      const committed = held();
      const dispatched: number[] = [];
      // The real service is the transport, so the per-instance ordering guard
      // and the stored row are exercised rather than simulated.
      const saver = createProgressSaver(async (payload, options) => {
        dispatched.push(options.sequence);
        // The normal write is still in flight when the page hides.
        if (options.sequence === 1) await gate.promise;
        await saveReadingProgress(svc, identity, versionId, {
          passageId: payload.passageId,
          offsetRatio: payload.offsetRatio,
          instanceId: options.instanceId,
          sequence: options.sequence,
        });
        if (options.sequence === 2) committed.resolve();
      }, { instanceId: INSTANCE_A });

      const normal = saver.save(position);
      const keepalive = saver.save(position, { keepalive: true });
      expect(dispatched).toEqual([1, 2]);

      // The identical keepalive commits while the normal request is held.
      await committed.promise;
      const first = await getReadingProgress(svc, identity, versionId);
      expect(first?.passageId).toBe(second);
      expect(first?.offsetRatio).toBeCloseTo(0.4, 6);

      // Releasing the older normal write must not touch the row: its sequence
      // is lower, so the guard keeps the keepalive's commit authoritative.
      gate.resolve();
      await Promise.all([normal, keepalive]);
      const after = await getReadingProgress(svc, identity, versionId);
      expect(after?.passageId).toBe(second);
      expect(after?.offsetRatio).toBeCloseTo(0.4, 6);
      expect(after?.updatedAt).toBe(first?.updatedAt);
      saver.dispose();
    } finally {
      await cleanup();
    }
  });

  it('does not replay an older failure after a newer keepalive save has committed', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [first, second] = await passageIds(svc.db, versionId);

      const dispatched: number[] = [];
      const gate = held();
      const saver = createProgressSaver(async (payload, options) => {
        dispatched.push(options.sequence);
        if (options.sequence === 1) {
          await gate.promise;
          throw new Error('network failed');
        }
        // Every other dispatch is a real write, so a wrongly replayed older
        // position would actually overwrite the newer row asserted below.
        await saveReadingProgress(svc, identity, versionId, {
          passageId: payload.passageId,
          offsetRatio: payload.offsetRatio,
          instanceId: options.instanceId,
          sequence: options.sequence,
        });
      }, { instanceId: INSTANCE_A, retryDelayMs: 5 });

      // Normal request A begins, newer keepalive B is dispatched.
      const normal = saver.save({ passageId: first, offsetRatio: 0.1 });
      const keepalive = saver.save({ passageId: second, offsetRatio: 0.9 }, { keepalive: true });
      expect(dispatched).toEqual([1, 2]);

      // B succeeds first, A fails afterwards.
      await keepalive;
      gate.resolve();
      // Allow more than the retry delay for a stale requeue to fire.
      await new Promise((resolve) => setTimeout(resolve, 40));

      // A was not replayed as sequence 3, so the row is still B.
      expect(dispatched).toEqual([1, 2]);
      const stored = await getReadingProgress(svc, identity, versionId);
      expect(stored?.passageId).toBe(second);
      expect(stored?.offsetRatio).toBeCloseTo(0.9, 6);

      await normal;
      saver.dispose();
    } finally {
      await cleanup();
    }
  });

  it('keeps multi-tab last-write-wins: another instance always applies', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [first, second] = await passageIds(svc.db, versionId);
      setServices(svc);
      const app = createApp();
      const path = `/api/documents/${versionId}/progress`;
      const put = (body: Record<string, unknown>) => app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      await put(progressBody(first, 0.1, 100, INSTANCE_A));
      const other = await put(progressBody(second, 0.9, 1, INSTANCE_B));
      expect(other.status).toBe(200);
      expect(((await other.json()) as any).progress.passageId).toBe(second);

      const read = await app.request(path);
      expect(((await read.json()) as any).progress.passageId).toBe(second);
    } finally {
      await cleanup();
    }
  });

  it('rejects a passage that belongs to a different document version with no-store', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const first = await ingestSample(svc, identity);
      const versionId = first.versionId as string;
      // Same workspace, different content hash → a second immutable version.
      svc.fetchFn = mockFetch(SAMPLE_HTML.replace('generosity', 'kindness'));
      const second = await ingestSource(svc, identity, 'https://example.com/second-reading', {
        dnsResolve: publicDns,
      });
      expect(second.reused).toBe(false);
      const foreignPassage = (await passageIds(svc.db, second.versionId as string))[0];

      setServices(svc);
      const app = createApp();
      const res = await app.request(`/api/documents/${versionId}/progress`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(progressBody(foreignPassage, 0.3, 1)),
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const rows = (await svc.db.query(`SELECT count(*)::int AS n FROM reading_progress`)).rows[0] as any;
      expect(Number(rows.n)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('advertises PUT in the CORS preflight for progress writes', async () => {
    const { svc, cleanup } = await makeServices();
    try {
      setServices(svc);
      const app = createApp();
      const res = await app.request('/api/documents/00000000-0000-4000-8000-000000000000/progress', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    } finally {
      await cleanup();
    }
  });
});

describe('reader progress isolation: two users, one workspace', () => {
  it('each user reads and overwrites only their own resume point', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const passages = await passageIds(svc.db, versionId);
      const peer = await addWorkspacePeer(svc, identity.workspaceId, 'peer@bhasya.test');
      expect(peer.workspaceId).toBe(identity.workspaceId);

      const owner = await saveReadingProgress(svc, identity, versionId, {
        passageId: passages[1],
        offsetRatio: 0.35,
        instanceId: INSTANCE_A,
        sequence: 1,
      });
      expect(owner.passageId).toBe(passages[1]);

      // Same workspace does not mean shared progress.
      expect(await getReadingProgress(svc, peer, versionId)).toBeNull();

      await saveReadingProgress(svc, peer, versionId, {
        passageId: passages[2],
        offsetRatio: 0.7,
        instanceId: INSTANCE_B,
        sequence: 1,
      });

      const ownerAfter = await getReadingProgress(svc, identity, versionId);
      const peerAfter = await getReadingProgress(svc, peer, versionId);
      expect(ownerAfter?.passageId).toBe(passages[1]);
      expect(ownerAfter?.offsetRatio).toBeCloseTo(0.35, 6);
      expect(peerAfter?.passageId).toBe(passages[2]);
      expect(peerAfter?.offsetRatio).toBeCloseTo(0.7, 6);

      const rows = (await svc.db.query(
        `SELECT user_id FROM reading_progress WHERE document_version_id = $1`, [versionId],
      )).rows.map((row) => String((row as any).user_id)).sort();
      expect(rows).toEqual([identity.userId, peer.userId].sort());
    } finally {
      await cleanup();
    }
  });

  it('a user outside the workspace cannot read or write the document progress', async () => {
    const { svc, identity, cleanup } = await makeServices();
    try {
      const ing = await ingestSample(svc, identity);
      const versionId = ing.versionId as string;
      const [passageId] = await passageIds(svc.db, versionId);
      const outsider = await addOutsider(svc, 'outsider@bhasya.test');

      await expect(getReadingProgress(svc, outsider, versionId)).rejects.toMatchObject({ status: 404 });
      await expect(saveReadingProgress(svc, outsider, versionId, {
        passageId,
        offsetRatio: 0.5,
        instanceId: INSTANCE_B,
        sequence: 1,
      })).rejects.toMatchObject({ status: 404 });

      expect(await getReadingProgress(svc, identity, versionId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('authenticated handlers isolate two Better Auth users who share a workspace', async () => {
    process.env.BHASYA_USE_AUTH = '1';
    process.env.BETTER_AUTH_SECRET = TEST_SECRET;
    process.env.BETTER_AUTH_URL = 'http://localhost';

    const db = await openDb({ dataDir: 'memory://' });
    let app: ReturnType<typeof createApp> | null = null;
    try {
      await migrate(db);
      const svc: Services = {
        db,
        storage: new MemoryStorageAdapter(),
        router: new ModelRouter(new DevGroundedAdapter()),
        fetchFn: mockFetch(),
      };
      setServices(svc);
      app = createApp();

      const aliceEmail = 'alice-progress@bhasya.test';
      const bobEmail = 'bob-progress@bhasya.test';
      const alice = await signUp(app, aliceEmail);
      const bob = await signUp(app, bobEmail);
      expect(alice.status).toBe(200);
      expect(bob.status).toBe(200);

      // First authenticated request provisions each app user + workspace.
      expect((await app.request('/api/sources', { headers: { cookie: alice.cookie } })).status).toBe(200);
      expect((await app.request('/api/sources', { headers: { cookie: bob.cookie } })).status).toBe(200);

      const aliceId = await appUserId(db, aliceEmail);
      const bobId = await appUserId(db, bobEmail);
      const workspaceId = await ownedWorkspaceId(db, aliceId);
      const bobWorkspaceId = await ownedWorkspaceId(db, bobId);
      expect(bobWorkspaceId).not.toBe(workspaceId);

      // Bob joins Alice's workspace: same document, different readers.
      await db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member')`,
        [workspaceId, bobId],
      );

      const ing = await ingestSample(svc, { userId: aliceId, workspaceId, email: aliceEmail });
      const versionId = ing.versionId as string;
      const passages = await passageIds(db, versionId);
      const path = `/api/documents/${versionId}/progress`;

      const putAs = (cookie: string, body: Record<string, unknown>) => app!.request(path, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const aliceWrite = await putAs(alice.cookie, progressBody(passages[1], 0.25, 1, INSTANCE_A));
      expect(aliceWrite.status).toBe(200);
      expect(aliceWrite.headers.get('cache-control')).toBe('no-store');

      // Bob shares the workspace but starts with no progress of his own.
      const bobEmpty = await app.request(path, { headers: { cookie: bob.cookie } });
      expect(bobEmpty.status).toBe(200);
      expect(((await bobEmpty.json()) as any).progress).toBeNull();

      const bobWrite = await putAs(bob.cookie, progressBody(passages[2], 0.8, 1, INSTANCE_B));
      expect(bobWrite.status).toBe(200);

      const aliceRead = await app.request(path, { headers: { cookie: alice.cookie } });
      expect(aliceRead.status).toBe(200);
      const aliceProgress = ((await aliceRead.json()) as any).progress;
      expect(aliceProgress.passageId).toBe(passages[1]);
      expect(aliceProgress.offsetRatio).toBeCloseTo(0.25, 6);

      const bobRead = await app.request(path, { headers: { cookie: bob.cookie } });
      expect(bobRead.status).toBe(200);
      const bobProgress = ((await bobRead.json()) as any).progress;
      expect(bobProgress.passageId).toBe(passages[2]);
      expect(bobProgress.offsetRatio).toBeCloseTo(0.8, 6);

      const rows = (await db.query(
        `SELECT user_id FROM reading_progress WHERE document_version_id = $1`, [versionId],
      )).rows.map((row) => String((row as any).user_id)).sort();
      expect(rows).toEqual([aliceId, bobId].sort());
    } finally {
      setServices(null);
      await db.close?.();
    }
  });
});

function sessionCookieFrom(res: Response): string {
  const getSet = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raws: string[] = typeof getSet === 'function'
    ? getSet.call(res.headers)
    : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=[^;,]*;)/);
  return raws.map((s) => s.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function signUp(
  app: ReturnType<typeof createApp>,
  email: string,
): Promise<{ status: number; cookie: string }> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', name: email.split('@')[0] }),
  });
  return { status: res.status, cookie: sessionCookieFrom(res) };
}

async function appUserId(db: DbClient, email: string): Promise<string> {
  const row = (await db.query(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!row?.['id']) throw new Error(`app user missing for ${email}`);
  return String(row['id']);
}

async function ownedWorkspaceId(db: DbClient, userId: string): Promise<string> {
  const row = (await db.query(
    `SELECT id FROM workspaces WHERE owner_user_id = $1 LIMIT 1`, [userId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!row?.['id']) throw new Error('workspace missing');
  return String(row['id']);
}
