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

function fromMinorUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(MONEY_SCALE + 1, '0');
  const whole = digits.slice(0, -MONEY_SCALE);
  const fraction = digits.slice(-MONEY_SCALE);
  return `${sign}${whole}.${fraction}`;
}

// Exact three-way compare for two decimal-string money amounts. Never route this through
// moneyToNumber for the same reason moneyEquals doesn't: a float carries ~15 significant
// digits, so at MONEY_SCALE (18) two genuinely different amounts can compare equal, or
// worse, order backwards.
export function moneyCompare(a: string, b: string): -1 | 0 | 1 {
  const diff = toMinorUnits(a) - toMinorUnits(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

// Exact decimal multiplication of two money amounts (`amount * factor`), via the same
// bigint minor-units path as moneyEquals/moneyCompare - never JS float. Both operands are
// non-negative decimal strings; the result is truncated (not rounded) to MONEY_SCALE.
export function moneyScaleBy(amount: string, factor: string): string {
  const product = (toMinorUnits(amount) * toMinorUnits(factor)) / 10n ** BigInt(MONEY_SCALE);
  return fromMinorUnits(product);
}

export function moneyDivide(dividend: string, divisor: string): string {
  const divisorUnits = toMinorUnits(divisor);
  if (divisorUnits === 0n) {
    throw new RangeError('moneyDivide: division by zero');
  }
  const dividendUnits = toMinorUnits(dividend) * 10n ** BigInt(MONEY_SCALE);
  return fromMinorUnits(dividendUnits / divisorUnits);
}

// Exact decimal addition and subtraction over the same bigint minor-units path. Used to
// derive one side of a balance change from the other: reading the balance separately and
// then updating it leaves a window for a concurrent writer, and an append-only audit row
// that records the wrong `before` cannot be corrected afterwards.
export function moneyAdd(a: string, b: string): string {
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b));
}

export function moneySubtract(a: string, b: string): string {
  return fromMinorUnits(toMinorUnits(a) - toMinorUnits(b));
}

export function moneyFloorToScale(amount: string, scale: number): string {
  const divisor = 10n ** BigInt(MONEY_SCALE - scale);
  return fromUnitsAtScale(toMinorUnits(amount) / divisor, scale);
}

export function moneyCeilToScale(amount: string, scale: number): string {
  const divisor = 10n ** BigInt(MONEY_SCALE - scale);
  const units = toMinorUnits(amount);
  const scaledUnits = units / divisor + (units % divisor === 0n ? 0n : 1n);
  return fromUnitsAtScale(scaledUnits, scale);
}

function fromUnitsAtScale(units: bigint, scale: number): string {
  const digits = units.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale) || '0';
  return scale === 0 ? whole : `${whole}.${digits.slice(digits.length - scale)}`;
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
