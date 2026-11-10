'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserReq } from '@/lib/api';

/** Client Component: URL validation, import feedback and navigation. */
export function ImportForm() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    setError('');

    const candidate = url.trim();
    if (!candidate) {
      setError('Enter a page URL.');
      return;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.username || parsed.password) {
        setError('Remove any username or password from the URL.');
        return;
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('Use a publicly accessible HTTP or HTTPS page.');
        return;
      }
    } catch {
      setError('Enter a complete URL, including https://.');
      return;
    }

    setUrl(candidate);
    setBusy(true);

    try {
      const result = (await browserReq('/api/sources/ingest', {
        method: 'POST',
        body: JSON.stringify({ url: candidate }),
      })) as { versionId: string };

      if (typeof result?.versionId !== 'string' || !result.versionId.trim()) {
        throw new Error('The import finished without a document version.');
      }

      router.push(`/read/${result.versionId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not import this page.');
      setBusy(false);
    }
  }

  return (
    <form className="import-form" onSubmit={submit} aria-busy={busy}>
      <div className="import-row">
        <label className="visually-hidden" htmlFor="source-url">
          Page URL
        </label>
        <input
          id="source-url"
          className="import-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          required
          disabled={busy}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (error) setError('');
          }}
          placeholder="https://example.com/article"
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'import-help import-error' : 'import-help'}
        />
        <button className="btn import-submit" disabled={busy} type="submit">
          {busy ? 'Importing…' : 'Import page'}
        </button>
      </div>

      <p className="import-help" id="import-help">
        Public article and document pages work best.
      </p>

      {busy ? (
        <p className="import-status" role="status" aria-live="polite">
          Retrieving the page and preparing its passages.
        </p>
      ) : null}

      {error ? (
        <p className="error import-error" id="import-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
