import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    // Narrow test-infra fix: boot ONE embedded-Postgres cluster serially
    // before workers start (no PGlite contention), shared by the two
    // hyperdrive-* files via per-file databases. All other files unaffected
    // and still run in parallel; no global sequential suite, no timeout
    // changes.
    globalSetup: ['tests/global-setup.embedded-pg.ts'],
  },
});
