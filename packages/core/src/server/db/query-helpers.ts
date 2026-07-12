import { sql } from 'drizzle-orm';
import type { DrizzleTx } from './drizzle.js';

export function findOneOrThrow<T>(rows: T[], error: Error): T {
  const row = rows[0];
  if (row === undefined) throw error;
  return row;
}

export function pageToOffset(page: number, limit: number) {
  return (page - 1) * limit;
}

// The single sanctioned JS-side conversion point for a decimal-string money amount.
// Ledger writes and balance comparisons stay in SQL (numeric arithmetic); this is only
// for a coarse, non-ledger decision (a review-queue heuristic, a velocity/cap check)
// where float precision loss at the margins does not change the outcome.
export function moneyToNumber(amount: string): number {
  return Number(amount);
}

// Serialize a critical section per `key` with a transaction-scoped Postgres advisory lock
// (auto-released on commit/rollback). `hashtext` maps the string key to the required bigint. Must run in a transaction.
export async function withAdvisoryXactLock<T>(
  txn: DrizzleTx,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await txn.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  return fn();
}
