import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

const route = () => read('apps/web/app/api/[...path]/route.ts');
const clientApi = () => read('apps/web/lib/api.ts');
const serverApi = () => read('apps/web/lib/api.server.ts');
const reader = () => read('apps/web/components/ReaderClient.tsx');
const layout = () => read('apps/web/app/layout.tsx');

/**
 * The browser only calls same-origin `/api/*`; a Route Handler forwards to the
 * server-only API origin. These are source contracts: the transport has to
 * keep cookies, statuses, streaming, and cancellation intact.
 */
describe('same-origin API proxy contract', () => {
  it('proxies every HTTP method through one catch-all route handler', () => {
    expect(existsSync(join(process.cwd(), 'apps/web/app/api/[...path]/route.ts'))).toBe(true);
    const src = route();
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(src).toMatch(new RegExp(`export const ${method} = proxy`));
    }
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(src).toMatch(/export const runtime = 'nodejs'/);
  });

  it('resolves the upstream origin server-side and fails closed', () => {
    const src = route();
    expect(src).toMatch(/resolveApiOrigin/);
    expect(src).toMatch(/status: 503|textResponse\(503/);
    expect(src).not.toMatch(/localhost:8787/);
  });

  it('forwards cookies, statuses, and streaming bodies, including all Set-Cookie headers', () => {
    const src = route();
    expect(src).toMatch(/'cookie'/);
    expect(src).toMatch(/getSetCookie/);
    expect(src).toMatch(/responseHeaders\.append\('set-cookie', cookie\)/);
    expect(src).toMatch(/upstream\.status/);
    expect(src).toMatch(/upstream\.body/);
    expect(src).toMatch(/signal: request\.signal/);
    expect(src).toMatch(/content-disposition/);
  });

  it('never forwards hop-by-hop or host-derived headers and adds no CORS policy', () => {
    const src = route();
    expect(src).not.toMatch(/x-forwarded/);
    expect(src).not.toMatch(/Access-Control-Allow-Origin/);
    expect(src).not.toMatch(/content-encoding/);
  });

  it('keeps the upstream origin out of client-safe modules', () => {
    const client = clientApi();
    expect(client).not.toMatch(/next\/headers/);
    expect(client).not.toMatch(/process\.env\.BHASYA_API_URL/);
    expect(client).not.toMatch(/NEXT_PUBLIC_/);
    expect(client).not.toMatch(/localhost:8787/);
    expect(client).toMatch(/credentials: 'same-origin'/);
    expect(client).not.toMatch(/credentials: 'include'/);

    const server = serverApi();
    expect(server).toMatch(/from 'next\/headers'/);
    expect(server).toMatch(/headers\(\)\.get\('cookie'\)/);
    expect(server).toMatch(/BHASYA_API_URL|resolveApiOrigin/);
  });

  it('keeps Reader traffic relative and removes the injected API base', () => {
    const src = reader();
    expect(src).not.toMatch(/browserApiBase/);
    expect(src).not.toMatch(/localhost:8787/);
    expect(src).toMatch(/fetch\('\/api\/reading-sessions\/start'/);
    expect(src).toMatch(/fetch\('\/api\/reading-sessions\/end'/);
    expect(src).toMatch(/fetch\('\/api\/threads\/explain\/stream'/);
    expect(src).toMatch(/\/api\/threads\/\$\{threadId\}\/messages\/stream/);
    expect(src).toMatch(/\/api\/exports\/\$\{out\.exportId\}/);
    expect(layout()).not.toMatch(/__BHASYA_API__/);
  });

  it('enforces the request body limit incrementally while streaming', () => {
    const src = route();

    const readerStart = src.indexOf('async function readBodyLimited');
    const proxyStart = src.indexOf('async function proxy');

    expect(readerStart).toBeGreaterThanOrEqual(0);
    expect(proxyStart).toBeGreaterThan(readerStart);

    const bodyReader = src.slice(readerStart, proxyStart);

    expect(bodyReader).toMatch(/request\.body\?\.\getReader\(\)/);
    expect(bodyReader).toMatch(/totalBytes\s*\+=\s*value\.byteLength/);
    expect(bodyReader).toMatch(/totalBytes\s*>\s*MAX_BODY_BYTES/);
    expect(bodyReader).toMatch(/reader\.cancel\(\)/);
    expect(bodyReader).toMatch(/reader\.releaseLock\(\)/);

    expect(src).toMatch(/readBodyLimited\(request\)/);
    expect(src).not.toMatch(/request\.arrayBuffer\(\)/);
  });

});