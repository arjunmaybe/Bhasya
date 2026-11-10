/**
 * Server-only resolution of the Bhasya API origin.
 *
 * The browser never talks to the API origin directly: every browser request
 * goes to a same-origin `/api/*` path and the Route Handler proxy forwards it.
 * That keeps the session cookie first-party and means `BHASYA_API_URL` never
 * reaches a client bundle.
 *
 * - Explicit `BHASYA_API_URL` must be an absolute, credential-free http(s)
 *   origin with no path, query, or fragment. A malformed value throws so the
 *   deployment fails loudly instead of proxying somewhere unexpected.
 * - Otherwise local development falls back to the local Hono server.
 * - In production an unset value resolves to `null`, and callers fail closed
 *   (503 for the proxy, a thrown configuration error for server rendering).
 */

export const DEV_API_ORIGIN = 'http://localhost:8787';

type EnvLike = Record<string, string | undefined>;

function parseApiOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BHASYA_API_URL must be an absolute http(s) origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('BHASYA_API_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('BHASYA_API_URL must not include credentials');
  }
  if (url.search || url.hash) {
    throw new Error('BHASYA_API_URL must not include a query or fragment');
  }
  if (url.pathname !== '/') {
    throw new Error('BHASYA_API_URL must be an origin without a path');
  }
  return url.origin;
}

/**
 * Resolve the API origin for the current process.
 *
 * Throws on a malformed explicit value. Returns `null` only in production
 * when no origin is configured.
 */
export function resolveApiOrigin(env: EnvLike = process.env): string | null {
  const raw = typeof env.BHASYA_API_URL === 'string' ? env.BHASYA_API_URL.trim() : '';
  if (raw) return parseApiOrigin(raw);
  if (env.NODE_ENV === 'production') return null;
  return DEV_API_ORIGIN;
}
