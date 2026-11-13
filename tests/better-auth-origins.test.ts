import { describe, expect, it } from 'vitest';
import { getAuthForDb, migrate, openDb, type DbClient } from '@bhasya/db';

/**
 * Better Auth trusted origins are explicit configuration. The web origin must
 * be listed; the request Host / forwarding headers never grant trust.
 */

const SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
const PASSWORD = 'Password123!';

type SignUpResult = {
  status: number;
  body: { code?: string; message?: string; error?: { code?: string } };
  setCookies: string[];
};

async function withAuth<T>(
  env: Record<string, unknown>,
  fn: (db: DbClient, auth: Awaited<ReturnType<typeof getAuthForDb>>) => Promise<T>,
): Promise<T> {
  const db: DbClient = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  try {
    const auth = await getAuthForDb(db, { env });
    return await fn(db, auth);
  } finally {
    await db.close?.();
  }
}

async function signUpWithOrigin(
  auth: Awaited<ReturnType<typeof getAuthForDb>>,
  email: string,
  origin: string | null,
): Promise<SignUpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const res = await auth.handler(
    new Request('http://localhost:8787/api/auth/sign-up/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password: PASSWORD, name: 'Origin' }),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as SignUpResult['body'];
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === 'function'
    ? getSetCookie.call(res.headers)
    : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return { status: res.status, body, setCookies };
}

const sessionCookie = (cookies: string[]) =>
  cookies.find((cookie) => cookie.includes('better-auth.session_token=')) ?? '';

describe('Better Auth trusted origins', () => {
  it('accepts the configured web origin and sets a first-party session cookie', async () => {
    await withAuth(
      {
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: 'http://localhost:8787',
        BHASYA_USE_AUTH: '1',
        BHASYA_WEB_ORIGIN: 'http://localhost:3000',
        NODE_ENV: 'test',
      },
      async (_db, auth) => {
        const result = await signUpWithOrigin(auth, 'web@bhasya.test', 'http://localhost:3000');
        expect(result.status).toBe(200);

        const cookie = sessionCookie(result.setCookies);
        expect(cookie).toMatch(/^better-auth\.session_token=/);
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/SameSite=Lax/i);
        expect(cookie).toMatch(/Path=\//i);
        expect(cookie).not.toMatch(/Domain=/i);
      },
    );
  });

  it('rejects an unlisted origin', async () => {
    await withAuth(
      {
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: 'http://localhost:8787',
        BHASYA_USE_AUTH: '1',
        BHASYA_WEB_ORIGIN: 'http://localhost:3000',
        NODE_ENV: 'test',
      },
      async (_db, auth) => {
        // Vitest makes Better Auth skip its origin middleware, so evaluate the
        // configured context directly: the trusted set is exactly baseURL plus
        // the explicit web origin.
        const ctx = await (auth as unknown as {
          $context: Promise<{ isTrustedOrigin: (url: string) => boolean }>;
        }).$context;
        expect(ctx.isTrustedOrigin('http://localhost:3000')).toBe(true);
        expect(ctx.isTrustedOrigin('http://localhost:8787')).toBe(true);
        expect(ctx.isTrustedOrigin('http://evil.test')).toBe(false);

        const options = (auth as unknown as { options: { trustedOrigins?: unknown } }).options;
        expect(Array.isArray(options.trustedOrigins)).toBe(true);
        for (const entry of options.trustedOrigins as unknown[]) {
          expect(typeof entry).toBe('string');
          expect(String(entry)).not.toMatch(/\*/);
        }
      },
    );
  });

  it('contributes no extra origin when the web origin is unset', async () => {
    await withAuth(
      {
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: 'http://localhost:8787',
        BHASYA_USE_AUTH: '1',
        NODE_ENV: 'test',
      },
      async (_db, auth) => {
        const ctx = await (auth as unknown as {
          $context: Promise<{ isTrustedOrigin: (url: string) => boolean }>;
        }).$context;
        expect(ctx.isTrustedOrigin('http://localhost:8787')).toBe(true);
        expect(ctx.isTrustedOrigin('http://localhost:3000')).toBe(false);
      },
    );
  });

  it('marks the session cookie Secure behind an https base URL', async () => {
    await withAuth(
      {
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: 'https://api.bhasya.test',
        BHASYA_USE_AUTH: '1',
        BHASYA_WEB_ORIGIN: 'https://bhasya.test',
        NODE_ENV: 'test',
      },
      async (_db, auth) => {
        const result = await signUpWithOrigin(auth, 'secure@bhasya.test', 'https://bhasya.test');
        expect(result.status).toBe(200);
        const cookie = sessionCookie(result.setCookies);
        expect(cookie).toMatch(/^__Secure-better-auth\.session_token=/);
        expect(cookie).toMatch(/;\s*Secure/i);
      },
    );
  });

  it('refuses wildcard, path-bearing, and non-absolute web origins', async () => {
    for (const value of ['*', 'https://bhasya.test/app', 'bhasya.test']) {
      const db: DbClient = await openDb({ dataDir: 'memory://' });
      await migrate(db);
      try {
        await expect(
          getAuthForDb(db, {
            env: {
              BETTER_AUTH_SECRET: SECRET,
              BETTER_AUTH_URL: 'http://localhost:8787',
              BHASYA_WEB_ORIGIN: value,
              NODE_ENV: 'test',
            },
          }),
        ).rejects.toThrow(/BHASYA_WEB_ORIGIN/);
      } finally {
        await db.close?.();
      }
    }
  });

  it('refuses an http web origin when the API base is https', async () => {
    const db: DbClient = await openDb({ dataDir: 'memory://' });
    await migrate(db);
    try {
      await expect(
        getAuthForDb(db, {
          env: {
            BETTER_AUTH_SECRET: SECRET,
            BETTER_AUTH_URL: 'https://api.bhasya.test',
            BHASYA_WEB_ORIGIN: 'http://bhasya.test',
            NODE_ENV: 'test',
          },
        }),
      ).rejects.toThrow(/https/);
    } finally {
      await db.close?.();
    }
  });
});
