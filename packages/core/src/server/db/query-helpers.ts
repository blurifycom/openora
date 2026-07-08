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
