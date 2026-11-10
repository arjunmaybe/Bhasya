import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Contract test for Better Auth's AsyncLocalStorage fallback.
 *
 * `runWithTransaction` wraps the adapter transaction in AsyncLocalStorage so
 * nested database calls use the transaction-scoped adapter. If ALS
 * initialization fails, Better Auth deliberately falls back to running the
 * callback without a transaction. That is a real limitation, not a silent
 * success: callers must not assume `transaction: true` alone guarantees
 * atomicity. This test pins the fallback behavior so a Better Auth upgrade
 * cannot change it unnoticed.
 *
 * The package under test is nested under `better-auth`, so resolve its real
 * entry points rather than relying on a top-level hoist. The failure is
 * injected through Better Auth's global context object, which is the same
 * object `ensureAsyncStorage()` reads, rather than through a module mock.
 */

const require = createRequire(
  new URL('../packages/db/node_modules/better-auth/package.json', import.meta.url),
);
const contextEntry = require.resolve('@better-auth/core/context');
const globalEntry = join(dirname(contextEntry), 'global.mjs');

describe('Better Auth AsyncLocalStorage transaction scoping', () => {
  it('routes nested adapter lookups through the transaction adapter', async () => {
    const { runWithTransaction, getCurrentAdapter } = (await import(pathToFileURL(contextEntry).href)) as {
      runWithTransaction: (
        adapter: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
        fn: () => Promise<unknown>,
      ) => Promise<unknown>;
      getCurrentAdapter: (fallback: unknown) => Promise<unknown>;
    };

    const fallback = { marker: 'fallback' };
    const scoped = { marker: 'transaction' };
    let observed: unknown = null;

    await runWithTransaction(
      { transaction: async (fn) => fn(scoped) },
      async () => {
        observed = await getCurrentAdapter(fallback);
      },
    );

    expect(observed).toBe(scoped);
  });

  it('runs the callback without a transaction when ALS initialization fails', async () => {
    const { runWithTransaction } = (await import(pathToFileURL(contextEntry).href)) as {
      runWithTransaction: (
        adapter: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
        fn: () => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const { __getBetterAuthGlobal } = (await import(pathToFileURL(globalEntry).href)) as {
      __getBetterAuthGlobal: () => { context: Record<string, unknown> };
    };

    const context = __getBetterAuthGlobal().context;
    const previous = Object.getOwnPropertyDescriptor(context, 'adapterAsyncStorage');
    Object.defineProperty(context, 'adapterAsyncStorage', {
      configurable: true,
      get() {
        throw new Error('forced ALS initialization failure');
      },
    });

    try {
      const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ scoped: true }));
      const result = await runWithTransaction({ transaction }, async () => 'ran-without-transaction');

      expect(result).toBe('ran-without-transaction');
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(context, 'adapterAsyncStorage', previous);
      else delete context.adapterAsyncStorage;
    }
  });
});
