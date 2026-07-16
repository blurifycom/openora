import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { DrizzleService } from '@openora/core/server';

// Real-infra test harness: ephemeral Postgres databases + per-worker-isolated Redis,
// for the kernel adapter tests that must exercise the actual backend (Redis Streams
// consumer groups, BullMQ timing, SQL constraints) rather than an in-process double.
// A measured benchmark put the cost at ~36ms/test + ~200ms/file for createdb+migrate,
// so these run in the normal unit suite. See src/server/kernel/__tests__.

const INFRA_HINT = 'real-infra tests need postgres+redis - run `docker compose up -d`';

const ADMIN_DATABASE_URL =
  process.env['TEST_ADMIN_DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/postgres';
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';

// Per-vitest-worker logical Redis DB (0-15) so parallel workers never share keys.
const REDIS_DATABASE = Number(process.env['VITEST_POOL_ID'] ?? 1) % 16;

function withRedisDatabase(baseUrl: string, database: number): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * The Redis URL for THIS worker's logical DB, in the `redis://host:port/db` form that
 * ioredis-based drivers (BullMQ) parse. Keeps BullMQ on the same per-worker DB as
 * `createTestRedis`, so a `flush()` tears both down together.
 */
export function redisUrlForWorker(): string {
  return withRedisDatabase(REDIS_URL, REDIS_DATABASE);
}

/**
 * Poll until a Redis Streams consumer group exists on `stream`. The broker creates its
 * group lazily inside the read loop (at `$`), so a publish issued before the group
 * exists would be missed - tests await this after subscribing, before publishing.
 */
export async function waitForConsumerGroup(
  client: ReturnType<typeof createClient>,
  stream: string,
  group: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const groups = await client.xInfoGroups(stream);
      if (groups.some((g) => g.name === group)) {
        return;
      }
    } catch {
      // stream not created yet (MKSTREAM happens with the group) - keep polling
    }
    if (Date.now() > deadline) {
      throw new Error(`consumer group '${group}' on '${stream}' not ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return (
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN'
  );
}

function withDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A per-module migration entrypoint (`packages/core/src/<module>/migrate.ts`). */
export type Migration = (databaseUrl: string) => Promise<unknown>;

export type TestDb = {
  url: string;
  drizzle: DrizzleService;
  drop: () => Promise<void>;
};

/**
 * Create a throwaway `test_<random>` database, apply the given per-module migrations
 * against it, and return a `DrizzleService` bound to it. `drop()` disposes the pool
 * and drops the database with FORCE (terminating any lingering backends).
 */
export async function createTestDb(migrations: Migration[]): Promise<TestDb> {
  const database = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
  } catch (err) {
    await admin.end();
    if (isConnectionError(err)) {
      throw new Error(INFRA_HINT, { cause: err });
    }
    throw err;
  }

  const url = withDatabase(ADMIN_DATABASE_URL, database);
  for (const migrate of migrations) {
    await migrate(url);
  }

  // DrizzleService reads DATABASE_URL in its constructor; a test file owns one db, so
  // pointing the env at the ephemeral url just before construction is safe and matches
  // the composition root's contract (no second construction path to maintain).
  process.env['DATABASE_URL'] = url;
  const drizzle = new DrizzleService();

  return {
    url,
    drizzle,
    async drop(): Promise<void> {
      await drizzle.dispose();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

export type TestRedis = {
  client: ReturnType<typeof createClient>;
  flush: () => Promise<void>;
  quit: () => Promise<void>;
};

/**
 * Connect a node-redis client selected to a per-worker logical DB (VITEST_POOL_ID % 16),
 * so parallel vitest workers never collide on keys. `flush()` is a `flushDb` (safe - it
 * only clears this worker's logical DB), for tearing down between tests.
 */
export async function createTestRedis(): Promise<TestRedis> {
  // reconnectStrategy: false so a down Redis rejects connect() immediately with an
  // actionable error, instead of retrying forever and hanging the test run.
  const client = createClient({
    url: REDIS_URL,
    database: REDIS_DATABASE,
    socket: { reconnectStrategy: false, connectTimeout: 3000 },
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    throw new Error(INFRA_HINT, { cause: err });
  }
  return {
    client,
    async flush(): Promise<void> {
      await client.flushDb();
    },
    async quit(): Promise<void> {
      await client.quit();
    },
  };
}
