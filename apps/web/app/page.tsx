import type { Metadata } from 'next';
import { api, getSessionUser } from '@/lib/api.server';
import { ApiError } from '@/lib/api';
import { AuthRequired } from '@/components/AuthRequired';
import { ImportForm } from '@/components/ImportForm';
import { SignOutButton } from '@/components/SignOutButton';

export const metadata: Metadata = {
  title: 'Library',
  description: 'Browse and continue reading pages imported into Bhasya.',
  robots: { index: false, follow: false },
};

type Source = {
  id: string;
  url: string;
  title: string;
  latest_version_id: string | null;
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q: rawQuery } = await searchParams;
  const query = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 100) : '';

  let sources: Source[] = [];
  let loadError = false;
  let authRequired = false;

  try {
    const result = await api.listSources();
    sources = result.sources;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      authRequired = true;
    } else {
      loadError = true;
    }
  }

  if (authRequired) {
    return <AuthRequired next="/" surface="library" />;
  }

  const user = await getSessionUser();

  const normalizedQuery = query.toLocaleLowerCase('en');
  const filteredSources = normalizedQuery
    ? sources.filter((source) =>
        [source.title, source.url].some((value) =>
          value.toLocaleLowerCase('en').includes(normalizedQuery),
        ),
      )
    : sources;

  const sourceCount = loadError
    ? 'Unavailable'
    : query
      ? `${filteredSources.length} matches`
      : `${sources.length} recent ${sources.length === 1 ? 'source' : 'sources'}`;

  return (
    <div className="library-page">
      <header className="library-header">
        <p className="library-eyebrow">READING DESK</p>
        <h1>Library</h1>
        <p className="library-intro">
          Pages you have brought into Bhasya. Open one to continue reading
          with its passages and discussions.
        </p>
      </header>

      {user ? (
        <div className="library-session">
          <p className="library-session-email">Signed in as {user.email}</p>
          <SignOutButton />
        </div>
      ) : null}

      <section className="library-import" aria-labelledby="library-import-title">
        <div className="library-import-copy">
          <p className="library-eyebrow">ADD TO LIBRARY</p>
          <h2 id="library-import-title">Add a page</h2>
          <p>
            Paste a publicly accessible page URL. Bhasya will prepare it
            for passage-level reading.
          </p>
        </div>
        <div className="library-import-control">
          <ImportForm />
        </div>
      </section>

      <section className="library-sources" aria-labelledby="library-sources-title">
        <header className="library-sources-header">
          <div className="library-sources-copy">
            <p className="library-eyebrow">YOUR COLLECTION</p>
            <h2 id="library-sources-title">Recent sources</h2>
            <p className="library-count">{sourceCount}</p>
          </div>

          <form className="library-search" action="/" method="get" role="search">
            <label htmlFor="library-query" className="visually-hidden">
              Search recent source titles and URLs
            </label>
            <input
              id="library-query"
              type="search"
              name="q"
              defaultValue={query}
              maxLength={100}
              placeholder="Search titles or URLs"
            />
            <button type="submit" className="library-search-button">
              Search
            </button>
            {query ? (
              <a className="library-clear-search" href="/">
                Clear
              </a>
            ) : null}
          </form>
        </header>

        {loadError ? (
          <div className="library-message" role="alert">
            <h3>Could not load your library</h3>
            <p>
              The source list is unavailable. Check your connection and
              try loading it again.
            </p>
            <a href="/">Reload library</a>
          </div>
        ) : sources.length === 0 ? (
          <div className="library-message" role="status">
            <h3>Your library is empty</h3>
            <p>
              Import a public article or document using its URL above.
              It will appear here when it is ready to read.
            </p>
          </div>
        ) : filteredSources.length === 0 ? (
          <div className="library-message" role="status">
            <h3>No matching sources</h3>
            <p>
              No recent source title or URL matches “{query}”.
            </p>
            <a href="/">Clear search</a>
          </div>
        ) : (
          <ol className="source-list" aria-label="Recent imported sources">
            {filteredSources.map((source, index) => {
              const title = source.title.trim() || 'Untitled source';

              return (
                <li key={source.id}>
                  {source.latest_version_id ? (
                    <a
                      className="source-row source-row-link"
                      href={`/read/${source.latest_version_id}`}
                      aria-label={`Read ${title}`}
                    >
                      <span className="source-index" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="source-details">
                        <span className="source-title">{title}</span>
                        <span className="source-url">{source.url}</span>
                      </span>
                      <span className="source-open">Read</span>
                    </a>
                  ) : (
                    <div className="source-row source-row-pending">
                      <span className="source-index" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="source-details">
                        <span className="source-title">{title}</span>
                        <span className="source-url">{source.url}</span>
                      </span>
                      <span className="source-status">Not ready</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {!loadError && sources.length === 50 ? (
          <p className="library-limit-note">
            Search covers the 50 most recent sources returned by the library.
          </p>
        ) : null}
      </section>
    </div>
  );
}