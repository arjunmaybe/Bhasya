/**
 * Frozen transaction primitive (FROZEN — do not redesign).
 *
 * Rules:
 * - Transactions own DB transaction boundaries only.
 * - NEVER perform network/model work inside `withTransaction`.
 * - Pattern: BEGIN → create thread/message/event/evidence state → COMMIT,
 *   THEN perform model/network work, THEN a second short transaction to
 *   persist the assistant result.
 * - PG statement timeout is a backstop, not the enforcement mechanism.
 *   Enforcement is application/service discipline + code review.
 */

export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
};

export type TxClient = Queryable & { __txBrand: 'tx' };

const TX_TIMEOUT_MS = 8000;

export async function withTransaction<T>(
  db: Queryable & { queryRaw?: unknown },
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  // Hyperdrive/request-scoped path: the DbClient owns single-connection
  // transactions (one checked-out client for BEGIN…COMMIT). Direct-Pool and
  // PGlite paths below are unchanged.
  const delegated = (db as { transact?: <X>(fn: (tx: TxClient) => Promise<X>) => Promise<X> }).transact;
  if (typeof delegated === 'function') {
    return delegated(async (tx) => {
      try { await tx.query(`SET LOCAL statement_timeout = ${TX_TIMEOUT_MS}`); } catch { /* pglite may ignore */ }
      return fn(tx);
    });
  }
  const tx = db as unknown as TxClient & {
    __begin?: () => Promise<void>;
    __commit?: () => Promise<void>;
    __rollback?: () => Promise<void>;
  };
  if (typeof tx.__begin === 'function') {
    await tx.__begin();
    const timer = setTimeout(() => {}, TX_TIMEOUT_MS);
    try {
      const out = await fn(tx as TxClient);
      await tx.__commit!();
      clearTimeout(timer);
      return out;
    } catch (e) {
      try { await tx.__rollback!(); } catch { /* noop */ }
      clearTimeout(timer);
      throw e;
    }
  }
  // SQL-level fallback (pg / PGlite): BEGIN/COMMIT on the same client.
  await db.query('BEGIN');
  try {
    // Discipline guard: detect fetch() inside tx via flag in async context is
    // enforced by review; here we set a statement timeout backstop.
    try { await db.query(`SET LOCAL statement_timeout = ${TX_TIMEOUT_MS}`); } catch { /* pglite may ignore */ }
    const out = await fn(db as unknown as TxClient);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* noop */ }
    throw e;
  }
}
