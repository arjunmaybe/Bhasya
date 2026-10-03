import type { DbClient } from '@bhasya/db';

export interface RetrievalPassage {
  id: string;
  nodeId: string;
  structuralPath: string;
  text: string;
  ordinal: number;
}

/**
 * Architectural retrieval layer (Phase 1 slice):
 * Query → PostgreSQL FTS + pgvector → merge/rank → evidence.
 * For Explain-this-passage, L0 (exact passage) + L1 (siblings) are primary.
 * FTS/pgvector ranking is used where available; L0 is always rank 0.
 */
export async function retrieveExplainContext(
  db: DbClient,
  args: { documentVersionId: string; passageId: string; limit?: number },
): Promise<{ l0: RetrievalPassage; l1: RetrievalPassage[] }> {
  const limit = args.limit ?? 3;
  const l0r = await db.query(
    `SELECT id, node_id, structural_path, text, ordinal FROM passages WHERE id = $1 AND document_version_id = $2`,
    [args.passageId, args.documentVersionId],
  );
  const l0row = l0r.rows[0];
  if (!l0row) throw new Error('passage not found in document version');
  const l0: RetrievalPassage = {
    id: String(l0row.id), nodeId: String(l0row.node_id),
    structuralPath: String(l0row.structural_path), text: String(l0row.text),
    ordinal: Number(l0row.ordinal ?? 0),
  };
  // L1: same section (structural path prefix) ordered by proximity, then FTS peers.
  const sectionPrefix = l0.structuralPath.replace(/\/p\[\d+\]$/, '');
  const l1r = await db.query(
    `SELECT id, node_id, structural_path, text, ordinal FROM passages
      WHERE document_version_id = $1 AND id <> $2 AND structural_path LIKE $3 || '%'
      ORDER BY ordinal ASC LIMIT ${Number(limit)}`,
    [args.documentVersionId, args.passageId, sectionPrefix],
  );
  let l1: RetrievalPassage[] = l1r.rows.map((r) => ({
    id: String(r.id), nodeId: String(r.node_id), structuralPath: String(r.structural_path),
    text: String(r.text), ordinal: Number(r.ordinal ?? 0),
  }));
  if (l1.length === 0) {
    // Fallback within version: FTS similarity to L0 text (first 40 tokens).
    const q = l0.text.split(/\s+/).slice(0, 40).join(' ');
    try {
      const fts = await db.query(
        `SELECT id, node_id, structural_path, text, ordinal,
                ts_rank(fts, plainto_tsquery('english', $2)) AS rank
           FROM passages WHERE document_version_id = $1 AND id <> $3
           ORDER BY rank DESC LIMIT ${Number(limit)}`,
        [args.documentVersionId, q, args.passageId],
      );
      l1 = fts.rows.map((r) => ({
        id: String(r.id), nodeId: String(r.node_id), structuralPath: String(r.structural_path),
        text: String(r.text), ordinal: Number(r.ordinal ?? 0),
      }));
    } catch { l1 = []; }
  }
  return { l0, l1 };
}

export * from './providers.js';
