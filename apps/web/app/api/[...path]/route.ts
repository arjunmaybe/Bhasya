/**
 * Same-origin API proxy.
 *
 * The browser only ever calls `/api/*` on the web origin. This handler
 * forwards those requests to the Hono API origin from the server-only
 * `BHASYA_API_URL`, preserving:
 * - the HTTP method, path, query, body, and status,
 * - all `Set-Cookie` headers (first-party session cookies on the web host),
 * - streamed bodies (SSE explanations, PDF downloads) and client cancellation.
 *
 * Fail closed: an unconfigured production origin returns 503 instead of
 * falling back to a local or arbitrary host.
 */

import { resolveApiOrigin } from '@/lib/api-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 1024 * 1024;

/** Headers forwarded to the API. Everything else (host, forwarding hints) drops. */
const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'content-type',
  'accept',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
] as const;

/** Response headers sent back to the browser. `set-cookie` is handled separately. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'etag', 'last-modified'] as const;

function textResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function readBodyLimited(request: Request): Promise<ArrayBuffer | Response> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;

      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return textResponse(413, 'Request body is too large');
      }

      chunks.push(value);
    }
  } catch (err) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    console.error(
      '[web] API proxy request body read failed:',
      (err as Error)?.message ?? 'unknown',
    );
    return textResponse(400, 'Unable to read request body');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes.buffer as ArrayBuffer;
}

async function proxy(request: Request): Promise<Response> {
  let origin: string | null;
  try {
    origin = resolveApiOrigin(process.env);
  } catch (err) {
    // Malformed configuration is an operator error, never a client error.
    console.error('[web] invalid API origin configuration:', (err as Error)?.message ?? 'unknown');
    return textResponse(503, 'API origin is not configured');
  }
  if (!origin) {
    console.error('[web] BHASYA_API_URL is not configured for this deployment');
    return textResponse(503, 'API origin is not configured');
  }

  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith('/api/')) {
    return textResponse(400, 'Unsupported path');
  }

  const target = new URL(origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  if (target.origin !== new URL(origin).origin) {
    return textResponse(400, 'Unsupported path');
  }

  const method = request.method.toUpperCase();
  let body: ArrayBuffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return textResponse(413, 'Request body is too large');
    }
    const result = await readBodyLimited(request);
    if (result instanceof Response) return result;
    body = result;
  }

  const forwarded = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: forwarded,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    });
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error('[web] API proxy request failed:', (err as Error)?.message ?? 'unknown');
    return textResponse(502, 'API is unavailable');
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Every proxied response is user-scoped and must never be cached.
  responseHeaders.set('cache-control', 'no-store');

  const setCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof setCookie === 'function'
    ? setCookie.call(upstream.headers)
    : [upstream.headers.get('set-cookie')].filter((value): value is string => Boolean(value));
  for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);

  // Only rewrite redirects that stay on the API origin; never send the browser
  // to an unrelated Location value.
  const location = upstream.headers.get('location');
  if (location) {
    const resolved = new URL(location, target);
    if (resolved.origin === target.origin) {
      responseHeaders.set('location', `${resolved.pathname}${resolved.search}`);
    }
  }

  const hasBody = method !== 'HEAD' && upstream.status !== 204 && upstream.status !== 304;
  return new Response(hasBody ? upstream.body : null, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
