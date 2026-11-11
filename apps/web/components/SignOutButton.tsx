'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserReq } from '@/lib/api';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await browserReq('/api/auth/sign-out', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      router.replace('/');
      router.refresh();
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className="btn-ghost auth-signout"
      onClick={signOut}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? 'Signing out…' : failed ? 'Retry sign out' : 'Sign out'}
    </button>
  );
}
