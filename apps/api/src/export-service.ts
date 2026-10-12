/**
 * Reading-session PDF export — service.
 *
 * Synchronous MVP: authorize → fetch canonical rows + the caller's own
 * session rows → buildExportIR() → renderExportPdf() → StoragePort.put() →
 * INSERT exports row. No network fetch anywhere in this path (SSRF stays
 * outside it by construction), no thread IDs accepted from the client, and
 * only threads created by the authenticated user are ever included.
 *
 * Failure ordering is deliberate: render happens before any persistence, so
 * a renderer failure leaves no exports row and no artifact. The row insert
 * is last, so a database failure can only strand unreachable bytes under a
 * random key — never a row pointing at missing bytes.
 */
import { sha256Hex } from '@bhasya/core';
import { HttpError, authorize } from '../../../authorization/resource-resolvers.js';
import { buildExportIR, type ExportInput } from './export-ir.js';
import { renderExportPdf } from './export-pdf.js';
import type { Identity, Services } from './services.js';

export interface ExportDeps {
  renderPdf?: (ir: Parameters<typeof renderExportPdf>[0]) => Promise<Uint8Array>;
  newId?: () => string;
}

export interface CreatedExport {
  exportId: string;
  byteSize: number;
  threadCount: number;
  messageCount: number;
  truncated: boolean;
  downloadUrl: string;
}

/** StoragePort key for a generated artifact. No public URL is ever minted. */
export function exportStorageKey(versionId: string, exportId: string): string {
  return `exports/${versionId}/${exportId}.pdf`;
}

function asRows(value: unknown): Array<Record<string, any>> {
  if (value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows)) {
    return (value as { rows: Array<Record<string, any>> }).rows;
  }
  return [];
}

export async function createReadingSessionExport(
  svc: Services,
  identity: Identity,
  versionId: string,
  deps: ExportDeps = {},
): Promise<CreatedExport> {
  // 404 for foreign workspaces (enumeration-safe, same as other routes).
  await authorize(svc.db, identity, 'document_version', versionId);

  const version = (await svc.db.query(
    `SELECT v.id, v.source_id, v.version_no, v.content_hash, v.title, v.fetched_url,
            v.passage_count, v.node_count, v.created_at, s.url AS source_url
       FROM document_versions v JOIN sources s ON s.id = v.source_id
      WHERE v.id = $1`,
    [versionId],
  )).rows[0] as any;
  if (!version) throw new HttpError(404, 'not found');

  const nodes = asRows(await svc.db.query(
    `SELECT id, parent_id, node_type, depth, structural_path, text FROM document_nodes
      WHERE document_version_id = $1 ORDER BY structural_path`,
    [versionId],
  ));

  // Own threads only: created_by must be the caller. Client thread IDs are
  // never trusted — membership is derived here from persisted rows.
  const threads = asRows(await svc.db.query(
    `SELECT t.id, t.title, t.created_at,
            a.selected_text AS anchor_text, a.structural_path AS anchor_path, a.node_id AS anchor_node_id
       FROM threads t JOIN anchors a ON a.id = t.anchor_id
      WHERE a.document_version_id = $1 AND t.workspace_id = $2 AND t.created_by = $3
      ORDER BY a.structural_path, t.created_at`,
    [versionId, identity.workspaceId, identity.userId],
  ));
  const threadIds = threads.map((t) => String(t.id));

  let messages: Array<Record<string, any>> = [];
  let evidence: Array<Record<string, any>> = [];
  let citations: Array<Record<string, any>> = [];
  if (threadIds.length > 0) {
    messages = asRows(await svc.db.query(
      `SELECT id, thread_id, role, content, model_id, created_at FROM thread_messages
        WHERE thread_id = ANY($1) ORDER BY thread_id, created_at`,
      [threadIds],
    ));
    const messageIds = messages.map((m) => String(m.id ?? ''));
    if (messageIds.length > 0) {
      evidence = asRows(await svc.db.query(
        `SELECT e.id, e.thread_message_id, e.quote, e.scope_level, e.rank, p.structural_path AS passage_path
           FROM evidence e JOIN passages p ON p.id = e.passage_id
          WHERE e.thread_message_id = ANY($1) ORDER BY e.rank`,
        [messageIds],
      ));
      const evidenceIds = evidence.map((e) => String(e.id ?? ''));
      if (evidenceIds.length > 0) {
        citations = asRows(await svc.db.query(
          `SELECT ci.evidence_id, ci.label, p.structural_path AS passage_path
             FROM citations ci JOIN evidence e ON e.id = ci.evidence_id
             JOIN passages p ON p.id = e.passage_id
            WHERE ci.evidence_id = ANY($1)`,
          [evidenceIds],
        ));
      }
    }
  }

  // Section labels: heading text keyed by parent section node id; anchor
  // rows carry their leaf node id, whose parent is the section.
  const headingBySection = new Map<string, string>();
  const nodeById = new Map<string, Record<string, any>>();
  for (const n of nodes) {
    if (n.id) nodeById.set(String(n.id), n);
    if (String(n.node_type) === 'heading' && n.parent_id) {
      headingBySection.set(String(n.parent_id), String(n.text ?? ''));
    }
  }

  const messagesByThread = new Map<string, Array<Record<string, any>>>();
  for (const m of messages) {
    const key = String(m.thread_id);
    if (!messagesByThread.has(key)) messagesByThread.set(key, []);
    messagesByThread.get(key)!.push(m);
  }

  const inputThreads: ExportInput['threads'] = threads.map((t) => {
    const tid = String(t.id);
    const leaf = nodeById.get(String(t.anchor_node_id));
    const sectionId = leaf && leaf.parent_id ? String(leaf.parent_id) : '';
    const tids = new Set((messagesByThread.get(tid) ?? []).map((m) => String(m.id)));
    const ev = evidence.filter((e) => tids.has(String(e.thread_message_id)));
    const evIds = new Set(ev.map((e) => String(e.id)));
    const ci = citations.filter((c) => evIds.has(String(c.evidence_id)));
    return {
      id: tid,
      title: typeof t.title === 'string' ? t.title : '',
      createdAt: t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at ?? ''),
      anchorSelectedText: typeof t.anchor_text === 'string' ? t.anchor_text : '',
      anchorStructuralPath: typeof t.anchor_path === 'string' ? t.anchor_path : '',
      sectionLabel: headingBySection.get(sectionId) ?? null,
      messages: (messagesByThread.get(tid) ?? []).map((m) => ({
        role: String(m.role),
        content: typeof m.content === 'string' ? m.content : '',
        model_id: typeof m.model_id === 'string' ? m.model_id : null,
        created_at: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at ?? ''),
      })),
      evidence: ev.map((e) => ({
        quote: typeof e.quote === 'string' ? e.quote : '',
        scope_level: typeof e.scope_level === 'string' ? e.scope_level : 'L0',
        rank: typeof e.rank === 'number' ? e.rank : 0,
        passagePath: typeof e.passage_path === 'string' ? e.passage_path : '',
      })),
      citations: ci.map((c) => ({
        label: typeof c.label === 'string' ? c.label : '',
        passagePath: typeof c.passage_path === 'string' ? c.passage_path : '',
      })),
    };
  });

  const ir = buildExportIR({
    version: {
      title: typeof version.title === 'string' ? version.title : '',
      sourceUrl: typeof version.source_url === 'string' ? version.source_url : '',
      versionNo: typeof version.version_no === 'number' ? version.version_no : 1,
      importedAt: version.created_at instanceof Date ? version.created_at.toISOString() : String(version.created_at ?? ''),
      contentHash: typeof version.content_hash === 'string' ? version.content_hash : '',
      passageCount: typeof version.passage_count === 'number' ? version.passage_count : 0,
    },
    nodes: nodes.map((n) => ({
      node_type: String(n.node_type ?? ''),
      depth: typeof n.depth === 'number' ? n.depth : 0,
      structural_path: String(n.structural_path ?? ''),
      text: typeof n.text === 'string' ? n.text : '',
    })),
    threads: inputThreads,
  });

  // Render before persisting anything: a renderer failure leaves no row
  // and no artifact.
  const renderPdf = deps.renderPdf ?? renderExportPdf;
  const bytes = await renderPdf(ir);

  const newId = deps.newId ?? (() => crypto.randomUUID());
  const exportId = newId();
  const key = exportStorageKey(versionId, exportId);
  const inputHash = sha256Hex(
    [String(version.content_hash ?? ''), ...threadIds, ...messages.map((m) => String(m.id ?? ''))].join('\n'),
  );

  await svc.storage.put(key, bytes, 'application/pdf');
  await svc.db.query(
    `INSERT INTO exports (id, document_version_id, workspace_id, created_by, status, storage_key, byte_size, input_hash, thread_count)
     VALUES ($1,$2,$3,$4,'complete',$5,$6,$7,$8)`,
    [exportId, versionId, identity.workspaceId, identity.userId, key, bytes.length, inputHash, threads.length],
  );

  const t = ir.truncation;
  return {
    exportId,
    byteSize: bytes.length,
    threadCount: threads.length,
    messageCount: ir.totals.messageCount,
    truncated: t.passagesOmitted > 0 || t.threadsOmitted > 0 || t.messagesOmitted > 0 || t.charsTruncated > 0,
    downloadUrl: `/api/exports/${exportId}`,
  };
}

export interface ExportDownload {
  bytes: Uint8Array;
  byteSize: number;
  exportId: string;
}

/**
 * Owner-scoped download: the row must exist in the caller's workspace AND
 * belong to the caller (exports embed one user's threads). Anything else is
 * a 404, matching the enumeration-safe convention. Missing bytes are a 404.
 */
export async function getExportForDownload(
  svc: Services,
  identity: Identity,
  exportId: string,
): Promise<ExportDownload> {
  const row = (await svc.db.query(
    `SELECT id, storage_key, byte_size FROM exports WHERE id = $1 AND workspace_id = $2 AND created_by = $3`,
    [exportId, identity.workspaceId, identity.userId],
  )).rows[0] as any;
  if (!row || typeof row.storage_key !== 'string' || row.storage_key.length === 0) {
    throw new HttpError(404, 'not found');
  }
  const bytes = await svc.storage.get(row.storage_key);
  if (!bytes) throw new HttpError(404, 'not found');
  return { bytes, byteSize: bytes.length, exportId: String(row.id) };
}
