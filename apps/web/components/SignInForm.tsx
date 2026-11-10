'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, browserReq } from '@/lib/api';

function signInMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 400 || cause.status === 401) return 'Email or password is incorrect.';
    if (cause.status === 429) return 'Too many attempts. Wait a moment and try again.';
    if (cause.status >= 500) return 'Sign in is temporarily unavailable. Try again shortly.';
  }
  return 'Could not reach Bhasya. Check your connection and try again.';
}

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    setPending(true);
    try {
      await browserReq('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      router.replace(next);
      router.refresh();
    } catch (cause) {
      setError(signInMessage(cause));
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-field">
        <label htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
        />
      </div>

      <div className="auth-field">
        <label htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
        />
      </div>

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="btn auth-action"
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      <p className="auth-note">
        Accounts are provisioned for Bhasya readers. There is no self-serve sign-up.
      </p>
    </form>
  );
}
