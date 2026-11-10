import { describe, expect, it } from 'vitest';
import { getAuthForDb, getIdentityForRequest, migrate, openDb, type DbClient } from '@bhasya/db';

/**
 * Legacy account linking. An app `users` row may only be adopted by email when
 * the Better Auth address is verified — otherwise a fresh sign-up with a
 * legacy email would inherit that user's workspace. The stored
 * `external_user_id` link path is unchanged.
 */

const SECRET = 'bhasya-test-secret-0123456789abcdef-00000000';
const PASSWORD = 'Password123!';

const env = (): Record<string, unknown> => ({
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'http://localhost:8787',
  BHASYA_USE_AUTH: '1',
  NODE_ENV: 'test',
});

function cookieFrom(res: Response): string {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raws = typeof getSetCookie === 'function'
    ? getSetCookie.call(res.headers)
    : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=[^;,]*;)/);
  return raws.map((value) => value.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function newDb(): Promise<DbClient> {
  const db = await openDb({ dataDir: 'memory://' });
  await migrate(db);
  return db;
}

async function signUp(
  auth: Awaited<ReturnType<typeof getAuthForDb>>,
  email: string,
): Promise<{ status: number; cookie: string }> {
  const res = await auth.handler(
    new Request('http://localhost:8787/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Legacy' }),
    }),
  );
  return { status: res.status, cookie: cookieFrom(res) };
}

describe('legacy email-based account linking', () => {
  it('refuses to adopt an unverified email, then links once verified', async () => {
    const db = await newDb();
    try {
      const seeded = (await db.query(
        'INSERT INTO users (email, display_name) VALUES ($1,$2) RETURNING id',
        ['legacy@bhasya.test', 'Legacy Reader'],
      )).rows[0] as { id: string };
      const seededId = String(seeded.id);

      const auth = await getAuthForDb(db, { env: env() });
      const up = await signUp(auth, 'legacy@bhasya.test');
      expect(up.status).toBe(200);
      expect(up.cookie).toContain('better-auth.session_token=');

      // Unverified: the session is valid, but it must not resolve to the
      // legacy app user and must not write the link.
      const unverified = await getIdentityForRequest(
        db,
        new Headers({ cookie: up.cookie }),
        { env: env() },
      );
      expect(unverified).toBeNull();

      const untouched = (await db.query(
        'SELECT external_user_id FROM users WHERE id = $1',
        [seededId],
      )).rows[0] as { external_user_id: string | null };
      expect(untouched.external_user_id).toBeNull();

      const rows = (await db.query(
        'SELECT count(*) AS n FROM users WHERE email = $1',
        ['legacy@bhasya.test'],
      )).rows[0] as { n: unknown };
      expect(Number(rows.n)).toBe(1);

      // Verify the address the way an email-verification flow would.
      await db.query('UPDATE "user" SET "emailVerified" = true WHERE email = $1', [
        'legacy@bhasya.test',
      ]);

      const linked = await getIdentityForRequest(
        db,
        new Headers({ cookie: up.cookie }),
        { env: env() },
      );
      expect(linked?.userId).toBe(seededId);
      expect(linked?.workspaceId).toBeTruthy();

      const sessionRes = await auth.handler(
        new Request('http://localhost:8787/api/auth/get-session', {
          headers: { cookie: up.cookie },
        }),
      );
      const session = (await sessionRes.json()) as { user?: { id?: string } };
      const link = (await db.query(
        'SELECT external_user_id FROM users WHERE id = $1',
        [seededId],
      )).rows[0] as { external_user_id: string | null };
      expect(String(link.external_user_id)).toBe(String(session.user?.id));
    } finally {
      await db.close?.();
    }
  });

  it('refuses to re-point an app user already linked to another identity', async () => {
    const db = await newDb();
    try {
      // An app user with this email is already linked to a different Better
      // Auth identity (for example an older account on the same address).
      const seeded = (await db.query(
        'INSERT INTO users (email, display_name, external_user_id) VALUES ($1,$2,$3) RETURNING id',
        ['shared@bhasya.test', 'Original Reader', 'other-better-auth-id'],
      )).rows[0] as { id: string };
      const seededId = String(seeded.id);

      const auth = await getAuthForDb(db, { env: env() });
      const up = await signUp(auth, 'shared@bhasya.test');
      expect(up.status).toBe(200);

      // Verified address, so the only thing standing in the way is the
      // existing link. Adoption must fail closed rather than steal the row.
      await db.query('UPDATE "user" SET "emailVerified" = true WHERE email = $1', [
        'shared@bhasya.test',
      ]);

      const identity = await getIdentityForRequest(
        db,
        new Headers({ cookie: up.cookie }),
        { env: env() },
      );
      expect(identity).toBeNull();

      const link = (await db.query(
        'SELECT external_user_id FROM users WHERE id = $1',
        [seededId],
      )).rows[0] as { external_user_id: string | null };
      expect(link.external_user_id).toBe('other-better-auth-id');

      const rows = (await db.query(
        'SELECT count(*) AS n FROM users WHERE email = $1',
        ['shared@bhasya.test'],
      )).rows[0] as { n: unknown };
      expect(Number(rows.n)).toBe(1);

      // The Better Auth session itself is valid; only app authorization fails.
      const sessionRes = await auth.handler(
        new Request('http://localhost:8787/api/auth/get-session', {
          headers: { cookie: up.cookie },
        }),
      );
      const session = (await sessionRes.json()) as { user?: { id?: string } };
      expect(session.user?.id).toBeTruthy();
      expect(String(session.user?.id)).not.toBe('other-better-auth-id');
    } finally {
      await db.close?.();
    }
  });

  it('still creates an app user for a new, unlinked email', async () => {
    const db = await newDb();
    try {
      const auth = await getAuthForDb(db, { env: env() });
      const up = await signUp(auth, 'new-reader@bhasya.test');
      expect(up.status).toBe(200);

      const identity = await getIdentityForRequest(
        db,
        new Headers({ cookie: up.cookie }),
        { env: env() },
      );
      expect(identity?.userId).toBeTruthy();
      expect(identity?.email).toBe('new-reader@bhasya.test');
    } finally {
      await db.close?.();
    }
  });
});
