import { describe, expect, it } from 'vitest';
import { getAuthForDb, migrate, openDb, type DbClient } from '@bhasya/db';

/**
 * Public sign-up policy. Registration is closed in every authenticated
 * deployment; only Vitest and an explicitly configured loopback Worker smoke
 * test may enable it, and an explicit disable always wins.
 */

const SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
const PASSWORD = 'Password123!';

const baseEnv = (extra: Record<string, unknown>): Record<string, unknown> => ({
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'http://localhost:8787',
  BHASYA_USE_AUTH: '1',
  ...extra,
});

async function signUp(env: Record<string, unknown>, email: string) {
  const db: DbClient = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  try {
    const auth = await getAuthForDb(db, { env });
    const res = await auth.handler(
      new Request('http://localhost:8787/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, name: 'Gate' }),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      error?: { code?: string };
    };
    const count = (await db.query('SELECT count(*) AS n FROM "user"')).rows[0] as
      | { n?: unknown }
      | undefined;
    return { status: res.status, body, userCount: Number(count?.n ?? -1) };
  } finally {
    await db.close?.();
  }
}

describe('Better Auth sign-up gate', () => {
  it('rejects public sign-up in an authenticated deployment', async () => {
    const result = await signUp(baseEnv({ NODE_ENV: 'production' }), 'closed@bhasya.test');
    expect(result.status).toBe(400);
    expect(String(result.body.code ?? result.body.error?.code)).toBe(
      'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    );
    expect(result.userCount).toBe(0);
  });

  it('treats a non-test runtime as closed by default', async () => {
    // A local or deployed Worker with auth on, but no explicit test opt-in.
    const result = await signUp(baseEnv({ NODE_ENV: 'development' }), 'worker@bhasya.test');
    expect(result.status).toBe(400);
    expect(result.userCount).toBe(0);
  });

  it('lets an explicit disable win over any allow signal', async () => {
    const result = await signUp(
      baseEnv({
        NODE_ENV: 'test',
        VITEST: 'true',
        BHASYA_TEST_SIGNUP: '1',
        BHASYA_DISABLE_SIGNUP: '1',
      }),
      'disabled@bhasya.test',
    );
    expect(result.status).toBe(400);
    expect(result.userCount).toBe(0);
  });

  it('keeps sign-up available to Vitest', async () => {
    const result = await signUp(baseEnv({ NODE_ENV: 'test' }), 'vitest@bhasya.test');
    expect(result.status).toBe(200);
    expect(result.userCount).toBe(1);
  });

  it('allows an explicitly configured loopback Worker smoke test', async () => {
    const result = await signUp(
      baseEnv({
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'http://127.0.0.1:8787',
        BHASYA_TEST_SIGNUP: '1',
      }),
      'smoke@bhasya.test',
    );
    expect(result.status).toBe(200);
    expect(result.userCount).toBe(1);
  });

  it('ignores the smoke flag on a non-loopback origin', async () => {
    const result = await signUp(
      baseEnv({
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://api.bhasya.test',
        BHASYA_TEST_SIGNUP: '1',
      }),
      'remote@bhasya.test',
    );
    expect(result.status).toBe(400);
    expect(result.userCount).toBe(0);
  });
});
