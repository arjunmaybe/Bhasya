/**
 * Authenticated staging acceptance (deployed $0 Worker ONLY).
 *
 * Targets the already-deployed staging Worker through the real Better Auth
 * application flow — the unauthenticated `scripts/acceptance.ts` loop cannot
 * pass staging because protected routes return 401 without a session (by
 * design; production never seeds the dev user).
 *
 * Transport (locked $0 staging, see wrangler.toml + docs/staging-acceptance.md):
 * Worker → direct DATABASE_URL → Supabase PostgreSQL, Supabase Storage behind
 * StoragePort. Hyperdrive is intentionally NOT involved (future production
 * profile only). This script binds nothing and deploys nothing.
 *
 * Auth transport: session cookie jar, exactly as a real browser client behaves
 * (preserves Better Auth `set-cookie`, sends `Cookie` on later requests).
 * No service keys, no DB handles, no auth bypass.
 *
 * Top-level await needs module scope under the repo tsconfig (same as
 * scripts/acceptance.ts).
 *
 * Usage:
 *   BHASYA_API_URL=https://bhasya-api.devmesh-8143.workers.dev npx tsx scripts/acceptance-staging-auth.ts
 *
 * Credentials (never printed, never committed):
 *   BHASYA_STAGING_EMAIL + BHASYA_STAGING_PASSWORD → sign in with those, or
 *   unset both → create one unique temporary test identity via the real
 *   Better Auth signup endpoint (email/password auth is enabled in staging).
 *
 * Fails fast on the first unexpected result. Never prints passwords, cookies,
 * tokens, secrets, or authorization headers — only statuses, ids, and counts.
 */
export {};
const API = (process.env.BHASYA_API_URL ?? 'https://bhasya-api.devmesh-8143.workers.dev').replace(/\/$/, '');
const REQ_TIMEOUT_MS = Number(process.env.BHASYA_REQ_TIMEOUT_MS ?? 30000);
const INGEST_URL = 'https://example.com';

const ENV_EMAIL = process.env.BHASYA_STAGING_EMAIL?.trim() || '';
const ENV_PASSWORD = process.env.BHASYA_STAGING_PASSWORD ?? '';
if ((ENV_EMAIL && !ENV_PASSWORD) || (!ENV_EMAIL && ENV_PASSWORD)) {
  console.error('Provide both BHASYA_STAGING_EMAIL and BHASYA_STAGING_PASSWORD, or neither (to generate a temporary signup identity).');
  process.exit(2);
}

function strongPassword(): string {
  return `Stg-${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`.replaceAll('-', '');
}

// ── Cookie jar (names/values held in memory only; values never logged) ──
const jar = new Map<string, string>();

function receivedCookies(headers: Headers): string[] {
  const getSet = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSet === 'function') return getSet.call(headers);
  const single = headers.get('set-cookie') ?? '';
  return single.split(/,(?=[^;,]+=[^;,]*;)/).map((s) => s.trim()).filter(Boolean);
}

function storeCookies(setCookies: string[]): void {
  for (const c of setCookies) {
    const pair = c.split(';')[0]?.trim() ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

type ProbeResult = { status: number; body: any; setCookies: string[] };

async function req(path: string, init: { method?: string; body?: unknown } = {}): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  // Better Auth lifecycle endpoints require Origin; harmless on app routes.
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: API };
  const jarHeader = cookieHeader();
  if (jarHeader) headers['cookie'] = jarHeader;
  try {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as any;
    const setCookies = receivedCookies(res.headers);
    storeCookies(setCookies);
    return { status: res.status, body, setCookies };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${path} → TIMEOUT after ${REQ_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

let stepNo = 0;
// Failure bodies are logged redacted (token/password/cookie/secret values
// stripped) so a staging failure carries evidence without leaking credentials.
// Success details must stay token-free by construction at each call site.
function redactedBody(body: unknown): string {
  const text = JSON.stringify(body ?? null);
  const clean = text.replace(/"(token|password|secret|cookie|set-cookie|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
  return clean.slice(0, 200);
}
function check(name: string, cond: boolean, detail: string, failBody?: unknown): void {
  stepNo += 1;
  const extra = cond ? '' : ` body=${redactedBody(failBody)}`;
  console.log(`${cond ? 'PASS' : 'FAIL'} [${stepNo}] ${name} ${detail}${extra}`);
  if (!cond) {
    process.exitCode = 1;
    throw new Error(`staging acceptance failed at [${stepNo}]: ${name} ${detail}${extra}`);
  }
}

const h = await req('/healthz');
check('API online', h.status === 200 && (h.body as any)?.ok === true, `status=${h.status}`);

let email = ENV_EMAIL;
let password = ENV_PASSWORD;
if (!email) {
  email = `staging-acceptance-${Date.now().toString(36)}@bhasya.test`;
  password = strongPassword();
  const up = await req('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email, password, name: 'Staging Acceptance' },
  });
  if (up.status !== 200 && /sign[-_ ]?up.*(disabled|not allowed|forbidden)/i.test(String((up.body as any)?.error ?? up.body?.code ?? ''))) {
    console.error('PREREQUISITE: staging intentionally disables email signup and no BHASYA_STAGING_EMAIL/PASSWORD were provided. Cannot authenticate without altering auth.');
    process.exit(2);
  }
  check('signup staging test user', up.status === 200 && up.setCookies.length > 0, `status=${up.status} email=${email}`, up.body);
} else {
  console.log(`(using provided BHASYA_STAGING_EMAIL=${email})`);
}

const signin = await req('/api/auth/sign-in/email', {
  method: 'POST',
  body: { email, password },
});
check('sign-in establishes session', signin.status === 200 && signin.setCookies.length > 0, `status=${signin.status}`, signin.body);

const sess = await req('/api/auth/get-session');
const sessUser = (sess.body as any)?.user;
check('session check returns identity', sess.status === 200 && typeof sessUser?.id === 'string' && sessUser.id.length > 0, `status=${sess.status}`, sess.body);

const ing = await req('/api/sources/ingest', { method: 'POST', body: { url: INGEST_URL } });
const versionId = (ing.body as any)?.versionId as string | undefined;
const sourceId = (ing.body as any)?.sourceId as string | undefined;
const passageCount = Number((ing.body as any)?.passageCount ?? 0);
// ingestSource performs the StoragePort put before the DB transaction, so a
// 201 implies both the artifact write (Supabase Storage) and the DB writes.
check('ingest source (DB + StoragePort write)', ing.status === 201 && !!versionId && passageCount > 0, `status=${ing.status} passages=${passageCount}`, ing.body);

const list = await req('/api/sources');
const sources = Array.isArray((list.body as any)?.sources) ? (list.body as any).sources as any[] : [];
check('source list contains created source', list.status === 200 && sources.some((s) => s?.id === sourceId), `status=${list.status} count=${sources.length}`, list.body);

const doc = await req(`/api/documents/${versionId}`);
check('document read', doc.status === 200 && !!(doc.body as any)?.version, `status=${doc.status}`, doc.body);

const tree = await req(`/api/documents/${versionId}/tree`);
const nodes = Array.isArray((tree.body as any)?.nodes) ? (tree.body as any).nodes.length as number : 0;
const passages = Array.isArray((tree.body as any)?.passages) ? (tree.body as any).passages.length as number : 0;
check('document tree (nodes + passages)', tree.status === 200 && nodes > 0 && passages > 0, `status=${tree.status} nodes=${nodes} passages=${passages}`, tree.body);

const out = await req('/api/auth/sign-out', { method: 'POST', body: {} });
const after = await req('/api/sources');
check('logout invalidates session (401 after)', out.status === 200 && after.status === 401, `signout=${out.status} after=${after.status}`, out.body);

console.log('\nSTAGING ACCEPTANCE COMPLETE');
console.log(`test identity: ${email} (temporary Better Auth user + its source/version rows remain; no admin deletion API exists by design)`);
