/**
 * Server-side API access for Server Components and Server Actions.
 *
 * Forwards the incoming request's cookie (the Better Auth session) to the
 * API and keeps the upstream origin server-only. Never import this module
 * from a client component — use `@/lib/api` there instead.
 */

import { headers } from 'next/headers';
import { ApiError, createApi } from './api';
import { resolveApiOrigin } from './api-origin';

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigurationError';
  }
}

let warnedMissingOrigin = false;

function apiOrigin(): string {
  const origin = resolveApiOrigin(process.env);
  if (!origin) {
    if (!warnedMissingOrigin) {
      warnedMissingOrigin = true;
      console.error('[web] BHASYA_API_URL is not configured for this deployment');
    }
    throw new ApiConfigurationError('BHASYA_API_URL is not configured for this deployment');
  }
  return origin;
}

async function serverRequest(path: string, init?: RequestInit): Promise<any> {
  const cookie = headers().get('cookie');
  const res = await fetch(`${apiOrigin()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
    const message =
      typeof body.error === 'string' && body.error
        ? body.error
        : typeof body.message === 'string' && body.message
          ? body.message
          : `API ${res.status} on ${path}`;
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export const api = createApi(serverRequest);

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Best-effort server session probe for rendering sign-in/sign-out affordances.
 * Returns `null` when there is no session or the API is unreachable — the
 * page's own data call surfaces real outages, so this must not throw.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const body = (await serverRequest('/api/auth/get-session')) as
      | { user?: Partial<SessionUser> | null }
      | null;
    const user = body?.user;
    if (!user || typeof user.id !== 'string' || !user.id) return null;
    return {
      id: user.id,
      email: typeof user.email === 'string' ? user.email : '',
      name: typeof user.name === 'string' ? user.name : null,
    };
  } catch {
    return null;
  }
}
