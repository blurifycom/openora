import { createClient } from 'redis';

const BASE_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
const INFRA_HINT = 'integration tests need redis - run `docker compose up -d`';

/**
 * Logical databases handed to `bootTestApp`, allocated downward from 15. The core
 * harness is pinned to 0-7 (`VITEST_POOL_ID % 8`), so the two tiers stay clear of
 * each other and both integration suites can run concurrently against one Redis.
 *
 * This tier's 8 are split per worker, because the counter below is module state: every
 * worker would otherwise start at 15 and flush a database another worker was using.
 * `wallet-ledger-auto-withdrawal.e2e.test.ts` keeps three apps alive at once, so a
 * worker needs at least that many - which, on a default 16-database Redis, is what caps
 * `maxWorkers` at 2 in vitest.config.ts. Raising one without the other collides.
 */
const HIGHEST_DATABASE = 15;
const LOWEST_DATABASE = 8;
const DATABASES_PER_WORKER = 4;

const workerSlice = Math.max(0, Number(process.env['VITEST_POOL_ID'] ?? 1) - 1);
const sliceTop =
  HIGHEST_DATABASE -
  ((workerSlice * DATABASES_PER_WORKER) % (HIGHEST_DATABASE - LOWEST_DATABASE + 1));
const sliceBottom = sliceTop - DATABASES_PER_WORKER + 1;

let nextDatabase = sliceTop;

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
  nextDatabase = nextDatabase > sliceBottom ? nextDatabase - 1 : sliceTop;

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
