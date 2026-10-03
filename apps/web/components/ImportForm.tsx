'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserReq } from '@/lib/api';

/** Client Component: import form (browser fetch + navigation). */
export function ImportForm() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = (await browserReq('/api/sources/ingest', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim() }),
      })) as { versionId: string };
      router.push(`/read/${r.versionId}`);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : 'import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="import-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a book/document webpage URL…"
          inputMode="url"
          aria-label="Document URL"
        />
        <button className="btn" disabled={busy} type="submit">{busy ? 'Importing…' : 'Import'}</button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
