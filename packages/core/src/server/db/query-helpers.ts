import {
  MONEY_SCALE,
  MoneyAmountSchema,
  isUsableRtp,
  type ExchangeRateReader,
} from '@openora/core/contracts';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
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

export function isUniqueConstraintViolation(e: unknown): boolean {
  let current = e;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === '23505') {
      return true;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export function uniqueConstraintName(e: unknown): string | null {
  let current = e;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('constraint' in current && typeof current.constraint === 'string') {
      return current.constraint;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

export function moneyToNumber(amount: string): number {
  return Number(amount);
}

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

export function isPositiveMoney(value: string): boolean {
  return MoneyAmountSchema.safeParse(value).success && moneyCompare(value, '0') > 0;
}

const MONEY_EXPONENT_FORM = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,3})$/;

export function expandMoneyExponent(value: string): string {
  const match = MONEY_EXPONENT_FORM.exec(value);
  if (!match) {
    return value;
  }
  const [, whole = '', fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const plain =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const trimmed = plain.includes('.') ? plain.replace(/\.?0+$/, '') : plain;
  return trimmed.replace(/^0+(?=\d)/, '');
}

export function moneyCompare(a: string, b: string): -1 | 0 | 1 {
  const diff = toMinorUnits(a) - toMinorUnits(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function moneyMin(a: string, b: string): string {
  return moneyCompare(a, b) <= 0 ? a : b;
}

export function moneyMax(a: string, b: string): string {
  return moneyCompare(a, b) >= 0 ? a : b;
}

export function moneyScaleBy(amount: string, factor: string): string {
  const product = (toMinorUnits(amount) * toMinorUnits(factor)) / 10n ** BigInt(MONEY_SCALE);
  return fromMinorUnits(product);
}

export function moneyMultiplyDivide(amount: string, multiplier: string, divisor: string): string {
  const units = toMinorUnits(divisor);
  if (units === 0n) {
    throw new RangeError('moneyMultiplyDivide: division by zero');
  }
  return fromMinorUnits((toMinorUnits(amount) * toMinorUnits(multiplier)) / units);
}

export function moneyDivide(dividend: string, divisor: string): string {
  const divisorUnits = toMinorUnits(divisor);
  if (divisorUnits === 0n) {
    throw new RangeError('moneyDivide: division by zero');
  }
  const dividendUnits = toMinorUnits(dividend) * 10n ** BigInt(MONEY_SCALE);
  return fromMinorUnits(dividendUnits / divisorUnits);
}

export function moneyAdd(a: string, b: string): string {
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b));
}

export function moneySubtract(a: string, b: string): string {
  return fromMinorUnits(toMinorUnits(a) - toMinorUnits(b));
}

export function houseEdge(realAmount: string, rtp?: string | null): string {
  if (!isUsableRtp(rtp)) {
    return '0';
  }
  return moneyScaleBy(realAmount, moneySubtract('1', rtp));
}

export function moneyFloorToScale(amount: string, scale: number): string {
  const divisor = 10n ** BigInt(MONEY_SCALE - scale);
  const units = toMinorUnits(amount);
  const truncated = units / divisor;
  return fromUnitsAtScale(units < 0n && units % divisor !== 0n ? truncated - 1n : truncated, scale);
}

export function moneyCeilToScale(amount: string, scale: number): string {
  const divisor = 10n ** BigInt(MONEY_SCALE - scale);
  const units = toMinorUnits(amount);
  const truncated = units / divisor;
  return fromUnitsAtScale(units > 0n && units % divisor !== 0n ? truncated + 1n : truncated, scale);
}

function fromUnitsAtScale(units: bigint, scale: number): string {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  return scale === 0 ? `${sign}${whole}` : `${sign}${whole}.${digits.slice(digits.length - scale)}`;
}

export function sumMoney(amount: AnyColumn | SQL, where?: SQL): SQL<string> {
  return where
    ? sql<string>`coalesce(sum(${amount}) filter (where ${where}), 0)::numeric(38, 18)`
    : sql<string>`coalesce(sum(${amount}), 0)::numeric(38, 18)`;
}

export async function sumInPivot(
  rows: readonly { currency: string; total: string }[],
  pivotCurrency: string,
  rates: ExchangeRateReader | undefined,
  tx?: unknown,
): Promise<string | null> {
  let total = '0';
  for (const row of rows) {
    if (row.currency.toUpperCase() === pivotCurrency.toUpperCase()) {
      total = moneyAdd(total, row.total);
      continue;
    }
    const converted = rates
      ? await rates.convert(row.total, row.currency, pivotCurrency, tx)
      : null;
    if (converted === null) {
      return null;
    }
    total = moneyAdd(total, converted);
  }
  return total;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}

export function likePrefix(value: string): string {
  return `${escapeLike(value)}%`;
}

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

export async function withAdvisoryXactLock<T>(
  txn: DrizzleTx,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await txn.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  return fn();
}

export async function withAdvisoryXactLocks<T>(
  txn: DrizzleTx,
  keys: readonly string[],
  fn: () => Promise<T>,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<T> {
  if (keys.length > 0) {
    const keyList = sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    );
    const lockFn = sql.raw(
      mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock',
    );
    await txn.execute(
      sql`select ${lockFn}(lock_id) from (select distinct hashtext(key) as lock_id from unnest(array[${keyList}]::text[]) as key order by lock_id) as locks`,
    );
  }
  return fn();
}
