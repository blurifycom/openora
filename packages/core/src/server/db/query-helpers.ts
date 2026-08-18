import { MONEY_SCALE } from '@openora/core/contracts';
import { sql } from 'drizzle-orm';
import type { DrizzleTx } from './drizzle.js';

export function findOneOrThrow<T>(rows: T[], error: Error): T {
  const row = rows[0];
  if (row === undefined) {
    throw error;
  }
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

// Exact equality for two decimal-string money amounts, ignoring notation ("10" === "10.00").
// Never route this through moneyToNumber: a float carries ~15 significant digits, so at
// MONEY_SCALE two genuinely different amounts compare equal and an idempotency replay
// accepts a mismatched retry. Scaling to integer minor units keeps the compare exact.
export function moneyEquals(a: string, b: string): boolean {
  return toMinorUnits(a) === toMinorUnits(b);
}

function toMinorUnits(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole + fraction.padEnd(MONEY_SCALE, '0').slice(0, MONEY_SCALE));
}

// Run `fn` over `items` with at most `concurrency` promises in flight, results in input
// order. Use this instead of `Promise.all(items.map(fn))` whenever `items` comes from a
// query (unbounded) and `fn` touches the DB: an uncapped fan-out opens one pool connection
// per item, exhausts the pool, and starves every other query on the same Postgres instance.
// Enforced in service files by oss-module-shape/no-unbounded-db-fanout.
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
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
