/**
 * Signed-out state for pages whose data requires a session. Rendered by
 * Server Components when the API answers 401. It is a plain sign-in
 * destination — Bhasya does not offer self-serve registration.
 */
export function AuthRequired({
  next,
  surface,
}: {
  next: string;
  surface: 'library' | 'reader';
}) {
  const heading =
    surface === 'library' ? 'Sign in to open your library' : 'Sign in to continue reading';
  const body =
    surface === 'library'
      ? 'Your sources, highlights, and reading sessions are private to your account.'
      : 'This document, its highlights, and its discussions are private to your account.';

  return (
    <div className="auth-page">
      <header className="auth-header">
        <p className="library-eyebrow">{surface === 'library' ? 'LIBRARY' : 'READING'}</p>
        <h1>{heading}</h1>
        <p>{body}</p>
      </header>
      <p className="auth-actions">
        <a className="btn auth-action" href={`/signin?next=${encodeURIComponent(next)}`}>
          Sign in
        </a>
      </p>
    </div>
  );
}
