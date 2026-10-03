import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { ReaderClient } from '@/components/ReaderClient';

/**
 * Server Component: renders the document (SEO/server-rendered).
 * Selection, highlights, thread UI live in <ReaderClient />.
 */
export default async function ReadPage({ params }: { params: { versionId: string } }) {
  let version: any;
  let nodes: Array<{ id: string; parent_id: string | null; node_type: string; structural_path: string; text: string }> = [];
  let passages: Array<{ id: string; node_id: string; structural_path: string; text: string }> = [];
  let highlights: Array<{
    highlight_id: string; anchor_id: string; selected_text: string;
    structural_path: string; passage_id: string; thread_id: string | null;
  }> = [];
  try {
    const [v, tree, hl] = await Promise.all([
      api.getVersion(params.versionId),
      api.getTree(params.versionId),
      api.getHighlights(params.versionId),
    ]);
    version = v.version;
    nodes = tree.nodes;
    passages = tree.passages;
    highlights = hl.highlights;
  } catch {
    notFound();
  }

  const headings = nodes.filter((n) => n.node_type === 'heading');
  const passageByNode = new Map(passages.map((p) => [p.node_id, p]));

  return (
    <ReaderClient
      versionId={params.versionId}
      title={String(version.title ?? 'Untitled')}
      sourceUrl={String(version.source_url ?? version.fetched_url ?? '')}
      nodes={nodes}
      passages={passages}
      initialHighlights={highlights}
      headingBySection={Object.fromEntries(headings.map((h) => [h.parent_id ?? '', h.text]))}
      passageByNodeId={Object.fromEntries([...passageByNode.entries()].map(([k, v]) => [k, v.id]))}
    />
  );
}
