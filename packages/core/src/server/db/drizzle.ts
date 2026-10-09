import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export type DrizzleDb = NodePgDatabase;
export type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const DEFAULT_POOL_MAX = 10;
const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 5_000;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Sized by `DATABASE_POOL_MAX`. `DATABASE_POOL_ACQUIRE_TIMEOUT_MS` bounds the wait for a free
 * connection: an exhausted pool fails the waiting query instead of hanging it forever, so a
 * caller that takes a second connection while holding a transaction surfaces as an error.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: positiveIntegerEnv('DATABASE_POOL_MAX', DEFAULT_POOL_MAX),
    connectionTimeoutMillis: positiveIntegerEnv(
      'DATABASE_POOL_ACQUIRE_TIMEOUT_MS',
      DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
    ),
  });
}

export function createDrizzleDb(connectionString?: string): DrizzleDb {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  return drizzle(createPool(url), { casing: 'snake_case' });
}
