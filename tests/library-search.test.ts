import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Library search is a native GET form rendered by a Server Component.
 * The input must stay uncontrolled so the browser can accept typing, while the
 * server remains responsible for filtering source titles and URLs.
 */
const page = readFileSync(join(process.cwd(), 'apps/web/app/page.tsx'), 'utf8');

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `${startMarker} -> ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Library search', () => {
  it('uses a native GET form with an uncontrolled query and server-side title/URL filtering', () => {
    // The page must remain a Server Component: no client search state.
    expect(page).not.toMatch(/^\s*['"]use client['"]/m);

    const form = between(page, '<form className="library-search"', '</form>');
    expect(form).toMatch(/action="\/"/);
    expect(form).toMatch(/method="get"/);
    expect(form).toMatch(/type="search"/);
    expect(form).toMatch(/name="q"/);
    expect(form).toMatch(/defaultValue=\{query\}/);

    const input = between(form, '<input', '/>');
    const normalizedInput = input.replace(/\s+/g, ' ');
    expect(normalizedInput).toContain('defaultValue={query}');
    // A controlled value alongside defaultValue would make typing impossible.
    expect(normalizedInput.replace('defaultValue={query}', '')).not.toMatch(/value=\{query\}/);

    const filter = between(page, 'const filteredSources =', 'const sourceCount');
    expect(filter).toMatch(/\[source\.title, source\.url\]\.some/);
    expect(filter).toMatch(/toLocaleLowerCase\('en'\)\.includes\(normalizedQuery\)/);
  });
});
