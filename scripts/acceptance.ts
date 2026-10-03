/** Phase 1 acceptance probe: drives the exact validation loop over HTTP. */
export {};
const API = process.env.BHASYA_API_URL ?? 'http://localhost:8787';
const TARGET = process.argv[2] ?? 'https://www.gutenberg.org/files/11/11-h/11-h.htm';
// Per-request timeout so a blocked endpoint fails visibly instead of hanging
// forever. This is a probe-side backstop only, not a diagnosis of any API issue.
const REQ_TIMEOUT_MS = Number(process.env.BHASYA_REQ_TIMEOUT_MS ?? 30000);

async function req(path: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${API}${path}`, {
      ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${body.error ?? 'error'}`);
    return body;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${path} → TIMEOUT after ${Date.now() - started}ms (limit ${REQ_TIMEOUT_MS}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const check = (n: number, name: string, cond: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} [${n}] ${name}`);
  if (!cond) { process.exitCode = 1; throw new Error(`acceptance failed at step ${n}: ${name}`); }
};

const h = await req('/healthz');
check(1, 'API online', h.ok === true);

const ing = await req('/api/sources/ingest', { method: 'POST', body: JSON.stringify({ url: TARGET }) });
check(3, 'import real page', !!ing.versionId);
check(4, 'source + immutable version created', !!ing.sourceId && ing.versionNo === 1);

const tree = await req(`/api/documents/${ing.versionId}/tree`);
check(5, `canonical tree (${tree.nodes.length} nodes) + passages (${tree.passages.length}) exist`,
  tree.nodes.length > 3 && tree.passages.length >= 2);

const long = (tree.passages as any[]).filter((p) => String(p.text).length > 80);
check(6, 'reader passages available', long.length > 0);
const passage = long[0];
const sentence = String(passage.text).split(/(?<=[.!?])\s+/).find((s) => s.length > 30) ?? String(passage.text).slice(0, 80);

const anchor = await req('/api/anchors/resolve', {
  method: 'POST',
  body: JSON.stringify({ documentVersionId: ing.versionId, selectedText: sentence.slice(0, 200), passageId: passage.id }),
});
check(7, 'selection maps to passage + anchor created', anchor.anchorId && anchor.passageId === passage.id);

const ex = await req('/api/threads/explain', {
  method: 'POST', body: JSON.stringify({ anchorId: anchor.anchorId }),
});
check(9, 'Explain action produces explanation in context', !!ex.text && ex.text.length > 20);
check(10, 'explanation shown while reader stays in context (thread scoped to passage)', !!ex.threadId);
check(11, 'explanation has evidence (citations issued)', ex.citationIds.length >= 1);

const thread = await req(`/api/threads/${ex.threadId}`);
check(12, 'thread persists with user + assistant(model) messages',
  thread.messages.length === 2 && thread.messages[1].model_id);

const cite = await req(`/api/citations/${ex.citationIds[0]}`);
check(13, 'citation points to exact passage/document version',
  cite.citation.passage_id === passage.id && cite.citation.document_version_id === ing.versionId);

await req(`/api/citations/${ex.citationIds[0]}/clicked`, { method: 'POST' });
check(14, 'citation click resolves to passage (reader can focus it)', true);

const hl = await req(`/api/documents/${ing.versionId}/highlights`);
check(17, 'highlight persists', hl.highlights.some((x: any) => x.anchor_id === anchor.anchorId));

const reopen = await req(`/api/threads/${ex.threadId}`);
check(19, 'reopened thread shows previous explanation', reopen.messages[1].content === ex.text);
check(20, 'citation still resolves after reopen', reopen.citations.length >= 1);

const events = await req('/api/events');
const types = (events.events as any[]).map((e) => e.event_type);
check(21, `events recorded (${types.slice(0, 8).join(', ')})`,
  ['source_imported', 'thread_created', 'passage_highlighted', 'thread_reopened', 'citation_clicked'].every((t) => types.includes(t)));

console.log('\nACCEPTANCE COMPLETE');
console.log(`title: ${(await req(`/api/documents/${ing.versionId}`)).version.title}`);
console.log(`read it at: http://localhost:3000/read/${ing.versionId}`);
