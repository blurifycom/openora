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

/** The env variable that sizes a pool, and the size when it is unset. */
export type PoolSizeEnv = { env: string; fallback: number };

const MAIN_POOL_SIZE_ENV: PoolSizeEnv = { env: 'DATABASE_POOL_MAX', fallback: DEFAULT_POOL_MAX };

/**
 * Sized by `DATABASE_POOL_MAX`, or the env `size` names. `DATABASE_POOL_ACQUIRE_TIMEOUT_MS` bounds
 * the wait for a free connection: an exhausted pool fails the waiting query instead of hanging it
 * forever, so a caller that takes a second connection while holding a transaction surfaces as an
 * error.
 */
export function createPool(connectionString: string, size: PoolSizeEnv = MAIN_POOL_SIZE_ENV): Pool {
  return new Pool({
    connectionString,
    max: positiveIntegerEnv(size.env, size.fallback),
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
