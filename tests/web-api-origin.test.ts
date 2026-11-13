import { describe, expect, it } from 'vitest';
import { DEV_API_ORIGIN, resolveApiOrigin } from '../apps/web/lib/api-origin.js';

/**
 * Server-only API origin resolution. The browser never sees this value; the
 * Route Handler proxy uses it to reach the Hono API from the web server.
 */
describe('web API origin resolution', () => {
  it('falls back to the local Hono server outside production', () => {
    expect(resolveApiOrigin({ NODE_ENV: 'development' })).toBe(DEV_API_ORIGIN);
    expect(resolveApiOrigin({})).toBe(DEV_API_ORIGIN);
  });

  it('fails closed in production when no origin is configured', () => {
    expect(resolveApiOrigin({ NODE_ENV: 'production' })).toBeNull();
    expect(resolveApiOrigin({ NODE_ENV: 'production', BHASYA_API_URL: '   ' })).toBeNull();
  });

  it('accepts an explicit absolute origin and normalises it', () => {
    expect(
      resolveApiOrigin({ NODE_ENV: 'production', BHASYA_API_URL: 'https://api.bhasya.test/' }),
    ).toBe('https://api.bhasya.test');
    expect(
      resolveApiOrigin({ NODE_ENV: 'development', BHASYA_API_URL: 'http://127.0.0.1:8787' }),
    ).toBe('http://127.0.0.1:8787');
  });

  it('rejects malformed configuration instead of proxying somewhere unexpected', () => {
    const invalid = [
      'api.bhasya.test',
      'ftp://api.bhasya.test',
      'https://user:pass@api.bhasya.test',
      'https://api.bhasya.test/base',
      'https://api.bhasya.test/?x=1',
      'https://api.bhasya.test/#frag',
      '*',
    ];
    for (const value of invalid) {
      expect(() => resolveApiOrigin({ NODE_ENV: 'production', BHASYA_API_URL: value })).toThrow(
        /BHASYA_API_URL/,
      );
    }
  });
});
