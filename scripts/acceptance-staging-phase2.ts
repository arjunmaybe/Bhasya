/**
 * Phase 2 staging acceptance (deployed $0 Worker ONLY).
 *
 * Verifies the existing Phase 2 instrumentation through real HTTP + real
 * Better Auth sessions (cookie jar per user, as a browser behaves):
 * passage-scoped thread open/read, reopen idempotency, citation→evidence→
 * passage/version resolution, citation_viewed attribution, unauthenticated
 * 401 + no attribution, cross-workspace 404 isolation, /api/events user_id
 * funnel, explanation model/latency metadata privacy, unknown-ID 404s.
 *
 * Transport (locked $0): Worker → direct DATABASE_URL → Supabase PG,
 * Supabase Storage behind StoragePort. Binds nothing, deploys nothing.
 * No service keys, no DB handles, no auth bypass, no RLS weakening.
 *
 * Usage:
 *   BHASYA_API_URL=https://bhasya-api.devmesh-8143.workers.dev npx tsx scripts/acceptance-staging-phase2.ts
 *
 * Credentials: unset → two unique temporary identities via real signup.
 * Never prints passwords, cookies, tokens, or secrets — statuses/ids/counts only.
 */
export {};
const API = (process.env.BHASYA_API_URL ?? 'https://bhasya-api.devmesh-8143.workers.dev').replace(/\/$/, '');
const REQ_TIMEOUT_MS = Number(process.env.BHASYA_REQ_TIMEOUT_MS ?? 30000);
const INGEST_URL = 'https://example.com';
const MISSING_ID = '00000000-0000-0000-0000-000000000099';

function strongPassword(): string {
  return `Stg-${globalThis.crypto.randomUUID()}${globalThis.crypto.randomUUID()}`.replaceAll('-', '');
}

function makeJar() {
  const jar = new Map<string, string>();
  return {
    storeCookies(setCookies: string[]): void {
      for (const c of setCookies) {
        const pair = c.split(';')[0]?.trim() ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header(): string {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

function receivedCookies(headers: Headers): string[] {
  const getSet = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSet === 'function') return getSet.call(headers);
  const single = headers.get('set-cookie') ?? '';
  return single.split(/,(?=[^;,]+=[^;,]*;)/).map((s) => s.trim()).filter(Boolean);
}

type ProbeResult = { status: number; body: any; setCookies: string[] };

async function req(
  jar: { storeCookies: (s: string[]) => void; header: () => string },
  path: string,
  init: { method?: string; body?: unknown; cookieOverride?: string | null } = {},
): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: API };
  if (init.cookieOverride === null) {
    // explicitly unauthenticated
  } else if (init.cookieOverride !== undefined) {
    headers['cookie'] = init.cookieOverride;
  } else {
    const h = jar.header();
    if (h) headers['cookie'] = h;
  }
  try {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as any;
    const setCookies = receivedCookies(res.headers);
    jar.storeCookies(setCookies);
    return { status: res.status, body, setCookies };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`${path} → TIMEOUT after ${REQ_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

let stepNo = 0;
function redactedBody(body: unknown): string {
  const text = JSON.stringify(body ?? null);
  return text.replace(/"(token|password|secret|cookie|set-cookie|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"').slice(0, 300);
}
function check(name: string, cond: boolean, detail: string, failBody?: unknown): void {
  stepNo += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} [${stepNo}] ${name} ${detail}${cond ? '' : ` body=${redactedBody(failBody)}`}`);
  if (!cond) {
    process.exitCode = 1;
    throw new Error(`phase2 staging acceptance failed at [${stepNo}]: ${name} ${detail}`);
  }
}

const alice = makeJar();
const bob = makeJar();
const anon = makeJar();

const h = await req(alice, '/healthz');
check('API online', h.status === 200 && (h.body as any)?.ok === true, `status=${h.status}`);

const aliceEmail = `p2-staging-${Date.now().toString(36)}@bhasya.test`;
const alicePw = strongPassword();
const upA = await req(alice, '/api/auth/sign-up/email', { method: 'POST', body: { email: aliceEmail, password: alicePw, name: 'P2 Alice' } });
check('alice signup', upA.status === 200 && upA.setCookies.length > 0, `status=${upA.status}`, upA.body);
const inA = await req(alice, '/api/auth/sign-in/email', { method: 'POST', body: { email: aliceEmail, password: alicePw } });
check('alice sign-in', inA.status === 200 && inA.setCookies.length > 0, `status=${inA.status}`, inA.body);
const sessA = await req(alice, '/api/auth/get-session');
const aliceUserId = String((sessA.body as any)?.user?.id ?? '');
check('alice session identity', sessA.status === 200 && aliceUserId.length > 0, `status=${sessA.status}`, sessA.body);

const ing = await req(alice, '/api/sources/ingest', { method: 'POST', body: { url: INGEST_URL } });
const versionId = String((ing.body as any)?.versionId ?? '');
const sourceId = String((ing.body as any)?.sourceId ?? '');
check('ingest source', ing.status === 201 && !!versionId, `status=${ing.status}`, ing.body);

const tree = await req(alice, `/api/documents/${versionId}/tree`);
const passages = Array.isArray((tree.body as any)?.passages) ? (tree.body as any).passages : [];
check('tree passages', tree.status === 200 && passages.length > 0, `status=${tree.status} passages=${passages.length}`, tree.body);
const p0 = passages[0] as { id: string; text: string };
const selectedText = String(p0.text ?? '').slice(0, Math.min(60, String(p0.text ?? '').length));
check('selection slice', selectedText.trim().length > 0, `len=${selectedText.length}`);

const res = await req(alice, '/api/anchors/resolve', { method: 'POST', body: { documentVersionId: versionId, selectedText } });
const anchorId = String((res.body as any)?.anchorId ?? '');
const anchorPassageId = String((res.body as any)?.passageId ?? '');
check('resolve anchor', res.status === 201 && !!anchorId, `status=${res.status}`, res.body);

const ex = await req(alice, '/api/threads/explain', { method: 'POST', body: { anchorId } });
const threadId = String((ex.body as any)?.threadId ?? '');
const citeIds = Array.isArray((ex.body as any)?.citationIds) ? (ex.body as any).citationIds.map(String) : [];
const modelId = String((ex.body as any)?.modelId ?? '');
check('open passage thread (explain)', ex.status === 201 && !!threadId && citeIds.length > 0, `status=${ex.status} citations=${citeIds.length}`, ex.body);
const citeId = citeIds[0];

const t1 = await req(alice, `/api/threads/${threadId}`);
const m1 = Array.isArray((t1.body as any)?.messages) ? (t1.body as any).messages.length : -1;
const e1 = Array.isArray((t1.body as any)?.evidence) ? (t1.body as any).evidence.length : -1;
const c1 = Array.isArray((t1.body as any)?.citations) ? (t1.body as any).citations.length : -1;
check('read thread back', t1.status === 200 && m1 > 0 && e1 > 0 && c1 > 0, `status=${t1.status} msgs=${m1} ev=${e1} cites=${c1}`, t1.body);

const byA1 = await req(alice, `/api/threads/by-anchor/${anchorId}`);
const byCount1 = Array.isArray((byA1.body as any)?.threads) ? (byA1.body as any).threads.length : -1;
check('threads by anchor', byA1.status === 200 && byCount1 >= 1, `status=${byA1.status} count=${byCount1}`, byA1.body);

const t2 = await req(alice, `/api/threads/${threadId}`);
const m2 = Array.isArray((t2.body as any)?.messages) ? (t2.body as any).messages.length : -2;
const c2 = await req(alice, `/api/citations/${citeId}`);
const c2b = await req(alice, `/api/citations/${citeId}`);
const byA2 = await req(alice, `/api/threads/by-anchor/${anchorId}`);
const byCount2 = Array.isArray((byA2.body as any)?.threads) ? (byA2.body as any).threads.length : -2;
check(
  'reopen idempotency (no duplicate state)',
  t2.status === 200 && m2 === m1 && c2.status === 200 && c2b.status === 200 && byCount2 === byCount1,
  `reopen=${t2.status} msgs=${m1}->${m2} cites=${c2.status},${c2b.status} byAnchor=${byCount1}->${byCount2}`,
  t2.body,
);

const cite = await req(alice, `/api/citations/${citeId}`);
const cBody = (cite.body as any)?.citation ?? {};
check(
  'citation→evidence→passage/version',
  cite.status === 200 && String(cBody?.id ?? '') === citeId && String(cBody?.document_version_id ?? '') === versionId,
  `status=${cite.status} passage=${String(cBody?.passage_id ?? '').slice(0, 8)} versionMatch=${String(cBody?.document_version_id ?? '') === versionId}`,
  cite.body,
);
check('citation passage matches anchor passage', String(cBody?.passage_id ?? '') === anchorPassageId, `passage=${String(cBody?.passage_id ?? '').slice(0, 8)}`);

const ev = await req(alice, '/api/events');
const events = Array.isArray((ev.body as any)?.events) ? (ev.body as any).events : [];
// Events carry the app-internal users.id (server-derived from the Better Auth
// session via users.external_user_id); the session endpoint returns the Better
// Auth user id, so attribution is proven by funnel consistency, not by string
// equality with the session id.
const funnelIds = new Set(events.map((e: any) => String(e?.user_id ?? '')));
const funnelId = funnelIds.size === 1 ? [...funnelIds][0] : '';
const viewed = events.filter((e: any) => e?.event_type === 'citation_viewed' && String(e?.resource_id ?? '') === citeId);
check('citation_viewed attributed', ev.status === 200 && !!funnelId && viewed.length >= 1 && viewed.every((e: any) => String(e?.user_id ?? '') === funnelId), `status=${ev.status} viewed=${viewed.length}`, ev.body);
check('events user attribution', ev.status === 200 && !!funnelId && events.length > 0 && events.every((e: any) => String(e?.user_id ?? '') === funnelId), `count=${events.length}`);
const types = events.map((e: any) => String(e?.event_type ?? ''));
for (const t of ['source_imported', 'thread_created', 'passage_highlighted', 'citation_viewed']) {
  check(`funnel contains ${t}`, types.includes(t), `found=${types.includes(t)}`);
}
const threadEvents = events.filter((e: any) => (e?.event_type === 'thread_created' || e?.event_type === 'thread_message_sent') && String(e?.resource_id ?? '') === threadId);
check('explanation metadata present', threadEvents.length >= 1 && threadEvents.every((e: any) => typeof e?.metadata?.durationMs === 'number' && String(e?.metadata?.modelId ?? '').length > 0), `rows=${threadEvents.length} model=${String(threadEvents[0]?.metadata?.modelId ?? '')}`);
const forbidden = ['prompt', 'response', 'content', 'selection', 'text', 'email', 'ip'];
const leaked = threadEvents.flatMap((e: any) => forbidden.filter((f) => e?.metadata !== null && typeof e?.metadata === 'object' && f in (e.metadata as Record<string, unknown>)));
check('explanation metadata privacy', leaked.length === 0, `leaked=${leaked.join(',') || 'none'}`);

const anonCite = await req(anon, `/api/citations/${citeId}`, { cookieOverride: null });
check('unauthenticated citation 401', anonCite.status === 401, `status=${anonCite.status}`, anonCite.body);

const bobEmail = `p2-staging-bob-${Date.now().toString(36)}@bhasya.test`;
const bobPw = strongPassword();
const upB = await req(bob, '/api/auth/sign-up/email', { method: 'POST', body: { email: bobEmail, password: bobPw, name: 'P2 Bob' } });
check('bob signup', upB.status === 200 && upB.setCookies.length > 0, `status=${upB.status}`, upB.body);
const crossCite = await req(bob, `/api/citations/${citeId}`);
check('cross-workspace citation 404', crossCite.status === 404 && (crossCite.body as any)?.citation === undefined, `status=${crossCite.status}`, crossCite.body);
const crossThread = await req(bob, `/api/threads/${threadId}`);
check('cross-workspace thread 404', crossThread.status === 404, `status=${crossThread.status}`, crossThread.body);

const missC = await req(alice, `/api/citations/${MISSING_ID}`);
const missT = await req(alice, `/api/threads/${MISSING_ID}`);
const missD = await req(alice, `/api/documents/${MISSING_ID}`);
check('unknown IDs 404', missC.status === 404 && missT.status === 404 && (missD.status === 404 || missD.status === 400), `cite=${missC.status} thread=${missT.status} doc=${missD.status}`, missC.body);

const out = await req(alice, '/api/auth/sign-out', { method: 'POST', body: {} });
const after = await req(alice, '/api/sources');
check('logout invalidates session', out.status === 200 && after.status === 401, `signout=${out.status} after=${after.status}`, out.body);

console.log('\nSTAGING PHASE 2 COMPLETE');
console.log(`alice: ${aliceEmail} (source ${sourceId.slice(0, 8)} thread ${threadId.slice(0, 8)} citation ${citeId.slice(0, 8)} remain; no admin deletion API by design)`);
console.log(`bob: ${bobEmail} (isolation probe only; no content created)`);
