import { createClient } from 'redis';

const BASE_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const INFRA_HINT = 'integration tests need redis - run `docker compose up -d`';

/**
 * Logical databases handed to `bootTestApp`, allocated downward from 15. The core
 * unit harness allocates upward from `VITEST_POOL_ID % 16`, so the two tiers stay
 * clear of each other when both run against the same Redis.
 */
const HIGHEST_DATABASE = 15;
const LOWEST_DATABASE = 8;

let nextDatabase = HIGHEST_DATABASE;

function urlFor(database: number): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

export type TestRedisDatabase = {
  url: string;
  database: number;
  release: () => Promise<void>;
};

/**
 * Claim a Redis logical database for one booted app and flush it, so the app's
 * broker consumer groups, BullMQ keys, cache entries and rate-limiter counters
 * cannot collide with another app booted in the same file. `release()` flushes
 * again, returning the database to the pool.
 */
export async function acquireTestRedisDatabase(): Promise<TestRedisDatabase> {
  const database = nextDatabase;
  nextDatabase = nextDatabase > LOWEST_DATABASE ? nextDatabase - 1 : HIGHEST_DATABASE;

  const client = createClient({
    url: BASE_URL,
    database,
    socket: { reconnectStrategy: false, connectTimeout: 3000 },
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.flushDb();
  } catch (err) {
    throw new Error(INFRA_HINT, { cause: err });
  }

  return {
    url: urlFor(database),
    database,
    async release(): Promise<void> {
      await client.flushDb();
      await client.quit();
    },
  };
}
