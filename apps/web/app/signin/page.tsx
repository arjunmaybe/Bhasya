import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/api.server';
import { SignInForm } from '@/components/SignInForm';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

/**
 * Only same-origin application paths are accepted as a post-sign-in
 * destination. Anything else falls back to the library.
 */
function safeNext(raw: string | string[] | undefined): string {
  const value = typeof raw === 'string' ? raw : '';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.includes('\\') || value.includes(':')) return '/';
  // Never bounce back into the sign-in page itself.
  if (value === '/signin' || value.startsWith('/signin/') || value.startsWith('/signin?')) return '/';
  return value;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  const user = await getSessionUser();
  if (user) redirect(next);

  return (
    <div className="auth-page">
      <header className="auth-header">
        <p className="library-eyebrow">BHASYA</p>
        <h1>Sign in</h1>
        <p>Continue to your library and reading sessions.</p>
      </header>
      <SignInForm next={next} />
    </div>
  );
}
