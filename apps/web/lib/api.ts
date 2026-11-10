/**
 * API contract shared by server rendering and the browser.
 *
 * Every request goes to a same-origin `/api/*` path:
 * - In the browser, `browserReq` fetches the relative path directly.
 * - On the server, `apps/web/lib/api.server.ts` supplies the upstream origin
 *   and forwards the incoming session cookie.
 *
 * The upstream API origin is server-only (`BHASYA_API_URL`); nothing in this
 * module reads it, so this file stays safe to import from client components.
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type ApiRequest = (path: string, init?: RequestInit) => Promise<any>;

export interface PassageDto { id: string; node_id: string; ordinal: number; structural_path: string; text: string }
export interface NodeDto { id: string; parent_id: string | null; node_type: string; ordinal: number; depth: number; structural_path: string; text: string }

export interface HighlightDto {
  highlight_id: string; anchor_id: string; selected_text: string;
  structural_path: string; passage_id: string; thread_id: string | null; created_at: string;
}

export interface ExplainResult {
  threadId: string; userMessageId: string; assistantMessageId: string;
  text: string; modelId: string; citationIds: string[];
}

export interface ExportResult {
  exportId: string; byteSize: number; threadCount: number;
  messageCount: number; truncated: boolean; downloadUrl: string;
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

export function createApi(request: ApiRequest) {
  return {
    listSources: (): Promise<{ sources: Array<{ id: string; url: string; title: string; latest_version_id: string | null }> }> =>
      request('/api/sources'),
    ingest: (url: string): Promise<{ sourceId: string; versionId: string; title: string }> =>
      request('/api/sources/ingest', { method: 'POST', body: JSON.stringify({ url }) }),
    getVersion: (versionId: string): Promise<{ version: any }> => request(`/api/documents/${versionId}`),
    getTree: (versionId: string): Promise<{ nodes: NodeDto[]; passages: PassageDto[] }> =>
      request(`/api/documents/${versionId}/tree`),
    getHighlights: (versionId: string): Promise<{ highlights: HighlightDto[] }> =>
      request(`/api/documents/${versionId}/highlights`),
    resolveAnchor: (body: { documentVersionId: string; selectedText: string; passageId?: string }): Promise<{ anchorId: string; passageId: string }> =>
      request('/api/anchors/resolve', { method: 'POST', body: JSON.stringify(body) }),
    explain: (body: { anchorId: string; question?: string; threadId?: string }): Promise<ExplainResult> =>
      request('/api/threads/explain', { method: 'POST', body: JSON.stringify(body) }),
    getThread: (threadId: string): Promise<ThreadDetail> => request(`/api/threads/${threadId}`),
    threadsByAnchor: (anchorId: string): Promise<{ threads: Array<{ id: string }> }> =>
      request(`/api/threads/by-anchor/${anchorId}`),
    getCitation: (id: string): Promise<{ citation: CitationDto }> => request(`/api/citations/${id}`),
    postMessage: (threadId: string, content: string): Promise<ExplainResult> =>
      request(`/api/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
    requestExport: (versionId: string): Promise<ExportResult> =>
      request(`/api/documents/${versionId}/exports`, { method: 'POST' }),
  };
}

export type Api = ReturnType<typeof createApi>;

async function toApiError(res: Response, path: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  const message =
    typeof body.error === 'string' && body.error
      ? body.error
      : typeof body.message === 'string' && body.message
        ? body.message
        : `API ${res.status} on ${path}`;
  return new ApiError(res.status, message);
}

/**
 * Browser-side API request. Only relative `/api/*` paths are allowed so a
 * client component can never be pointed at an arbitrary third-party origin.
 */
export async function browserReq(path: string, init?: RequestInit): Promise<any> {
  if (!path.startsWith('/api/')) {
    throw new Error(`browserReq only accepts same-origin /api paths, received: ${path}`);
  }
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) throw await toApiError(res, path);
  return res.json();
}
