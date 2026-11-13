import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Authentication surface is sign-in / sign-out / signed-out states only.
 * There is no registration UI, no second auth system, and no invitation flow:
 * public sign-up is closed at the API.
 */

const root = process.cwd();
const webRoots = ['apps/web/app', 'apps/web/components', 'apps/web/lib'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const webFiles = webRoots.flatMap((dir) => walk(join(root, dir)));
const read = (file: string) => readFileSync(file, 'utf8');

describe('web authentication surface', () => {
  it('has no registration route, page, or form', () => {
    const registrationPaths = webFiles.filter((file) =>
      /sign-?up/i.test(relative(root, file)),
    );
    expect(registrationPaths).toEqual([]);

    const signUpCalls = webFiles.filter((file) =>
      /\/api\/auth\/sign-up|signUpEmail/.test(read(file)),
    );
    expect(signUpCalls).toEqual([]);
  });

  it('sends an explicit JSON body with browser sign-out', () => {
    const signOut = read(join(root, 'apps/web/components/SignOutButton.tsx'));

    expect(signOut).toMatch(
      /browserReq\('\/api\/auth\/sign-out',\s*\{\s*method: 'POST',\s*body: JSON\.stringify\(\{\}\),\s*\}\)/,
    );
  });

  it('uses only Better Auth sign-in, sign-out, and session endpoints', () => {
    const endpoints = new Set<string>();
    for (const file of webFiles) {
      for (const match of read(file).matchAll(/\/api\/auth\/[a-z-]+/g)) {
        endpoints.add(match[0]);
      }
    }
    expect([...endpoints].sort()).toEqual([
      '/api/auth/get-session',
      '/api/auth/sign-in',
      '/api/auth/sign-out',
    ]);
  });

  it('accepts only same-origin destinations after sign-in', () => {
    const page = read(join(root, 'apps/web/app/signin/page.tsx'));
    expect(page).toMatch(/startsWith\('\/\/'\)/);
    expect(page).toMatch(/includes\('\\\\'\)/);
    expect(page).toMatch(/includes\(':'\)/);
    expect(page).toMatch(/redirect\(next\)/);
  });

  it('links signed-out states to the sign-in page', () => {
    const gate = read(join(root, 'apps/web/components/AuthRequired.tsx'));
    expect(gate).toMatch(/\/signin\?next=/);
    expect(gate).toMatch(/encodeURIComponent\(next\)/);
  });

  it('keeps public sign-up closed in committed deployment config', () => {
    const wrangler = read(join(root, 'apps/api/wrangler.toml'));
    expect(wrangler).toMatch(/BHASYA_DISABLE_SIGNUP = "1"/);
    expect(wrangler.match(/BHASYA_DISABLE_SIGNUP = "1"/g)?.length).toBe(2);
    expect(wrangler).not.toMatch(/BHASYA_ALLOW_SIGNUP/);

    const env = read(join(root, '.env.example'));
    expect(env).not.toMatch(/BHASYA_ALLOW_SIGNUP/);
    expect(env).not.toMatch(/NEXT_PUBLIC_BHASYA_API_URL/);
    expect(env).toMatch(/BHASYA_API_URL/);
  });
});
