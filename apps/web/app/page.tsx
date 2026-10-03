import { api } from '@/lib/api';
import { ImportForm } from '@/components/ImportForm';

/** Server Component: library home. Interactive import isolated to a client component. */
export default async function Home() {
  let sources: Array<{ id: string; url: string; title: string; latest_version_id: string | null }> = [];
  let loadError = '';
  try {
    const r = await api.listSources();
    sources = r.sources;
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'API unavailable';
  }

  return (
    <div className="home">
      <h1>Read with AI attached to the text</h1>
      <p className="sub">Import a page, select a passage, get an explanation grounded in that exact passage — and come back to it later.</p>
      <ImportForm />
      {loadError ? (
        <p className="error">Library unavailable ({loadError}). Start the API on :8787, then reload.</p>
      ) : sources.length === 0 ? (
        <p className="sub">No documents yet. Paste a URL above to import your first page.</p>
      ) : (
        <ul className="source-list">
          {sources.map((s) => (
            <li key={s.id}>
              {s.latest_version_id ? (
                <a href={`/read/${s.latest_version_id}`}>
                  <div className="t">{s.title || 'Untitled'}</div>
                  <div className="u">{s.url}</div>
                </a>
              ) : (
                <a href="/" aria-disabled="true">
                  <div className="t">{s.title || 'Untitled'}</div>
                  <div className="u">{s.url} (no version yet)</div>
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
