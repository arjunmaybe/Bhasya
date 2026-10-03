export const API_URL =
  process.env.BHASYA_API_URL ?? process.env.NEXT_PUBLIC_BHASYA_API_URL ?? 'http://localhost:8787';

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `API ${res.status} on ${path}`);
  }
  return res.json() as Promise<any>;
}

export interface PassageDto { id: string; node_id: string; ordinal: number; structural_path: string; text: string }
export interface NodeDto { id: string; parent_id: string | null; node_type: string; ordinal: number; depth: number; structural_path: string; text: string }

export const api = {
  listSources: (): Promise<{ sources: Array<{ id: string; url: string; title: string; latest_version_id: string | null }> }> =>
    req('/api/sources'),
  ingest: (url: string): Promise<{ sourceId: string; versionId: string; title: string }> =>
    req('/api/sources/ingest', { method: 'POST', body: JSON.stringify({ url }) }),
  getVersion: (versionId: string): Promise<{ version: any }> => req(`/api/documents/${versionId}`),
  getTree: (versionId: string): Promise<{ nodes: NodeDto[]; passages: PassageDto[] }> =>
    req(`/api/documents/${versionId}/tree`),
  getHighlights: (versionId: string): Promise<{ highlights: HighlightDto[] }> =>
    req(`/api/documents/${versionId}/highlights`),
  resolveAnchor: (body: { documentVersionId: string; selectedText: string; passageId?: string }): Promise<{ anchorId: string; passageId: string }> =>
    req('/api/anchors/resolve', { method: 'POST', body: JSON.stringify(body) }),
  explain: (body: { anchorId: string; question?: string; threadId?: string }): Promise<ExplainResult> =>
    req('/api/threads/explain', { method: 'POST', body: JSON.stringify(body) }),
  getThread: (threadId: string): Promise<ThreadDetail> => req(`/api/threads/${threadId}`),
  threadsByAnchor: (anchorId: string): Promise<{ threads: Array<{ id: string }> }> =>
    req(`/api/threads/by-anchor/${anchorId}`),
  getCitation: (id: string): Promise<{ citation: CitationDto }> => req(`/api/citations/${id}`),
  postMessage: (threadId: string, content: string): Promise<ExplainResult> =>
    req(`/api/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
};

export interface HighlightDto {
  highlight_id: string; anchor_id: string; selected_text: string;
  structural_path: string; passage_id: string; thread_id: string | null; created_at: string;
}

export interface ExplainResult {
  threadId: string; userMessageId: string; assistantMessageId: string;
  text: string; modelId: string; citationIds: string[];
}

export interface ThreadDetail {
  thread: { id: string; anchor_id: string; scope_type: string; title: string };
  messages: Array<{ id: string; role: string; content: string; model_id: string | null; created_at: string }>;
  evidence: Array<{ id: string; passage_id: string; document_version_id: string; scope_level: string; quote: string }>;
  citations: Array<{ id: string; evidence_id: string; anchor_id: string; label: string }>;
}

export interface CitationDto {
  id: string; label: string; locator: unknown; anchor_id: string;
  passage_id: string; document_version_id: string; scope_level: string;
  quote: string; passage_text: string; structural_path: string; node_id: string;
}

/** Browser-side helpers (client components only). */
export const browserApiBase = (): string =>
  (typeof window !== 'undefined' && (window as any).__BHASYA_API__) ||
  process.env.NEXT_PUBLIC_BHASYA_API_URL ||
  'http://localhost:8787';

export async function browserReq(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${browserApiBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `API ${res.status}`);
  }
  return res.json();
}
