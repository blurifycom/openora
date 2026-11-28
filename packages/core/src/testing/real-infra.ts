import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createClient } from 'redis';
import { DrizzleService } from '@openora/core/server';
import { ADMIN_DATABASE_URL } from './admin-database-url.js';

const INFRA_HINT = 'real-infra tests need postgres+redis - run `docker compose up -d`';

const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6380';

const REDIS_LOGICAL_DATABASE_COUNT = 8;
const POOL_SIZE = Number(process.env['OPENORA_TEST_POOL_SIZE'] ?? REDIS_LOGICAL_DATABASE_COUNT);
const STRYKER_WORKER = Number(process.env['STRYKER_MUTATOR_WORKER'] ?? 0);
const REDIS_DATABASE =
  (STRYKER_WORKER * POOL_SIZE + Number(process.env['VITEST_POOL_ID'] ?? 1)) %
  REDIS_LOGICAL_DATABASE_COUNT;

function withRedisDatabase(baseUrl: string, database: number): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export function redisUrlForWorker(): string {
  return withRedisDatabase(REDIS_URL, REDIS_DATABASE);
}

export async function waitForConsumerGroup(
  client: ReturnType<typeof createClient>,
  { stream, group, timeoutMs = 3000 }: { stream: string; group: string; timeoutMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const groups = await client.xInfoGroups(stream).catch(() => []);
    if (groups.some((g) => g.name === group)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`consumer group '${group}' on '${stream}' not ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type LockWaiterDb = Pick<TestDb, 'drizzle'>;

async function waitForLockWaiter(db: LockWaiterDb, lock: SQL, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.drizzle.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where ${lock} and not l.granted
            and a.datname = current_database()`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function waitForAdvisoryLockWaiter(db: LockWaiterDb, timeoutMs = 3000): Promise<void> {
  return waitForLockWaiter(db, sql`l.locktype = 'advisory'`, timeoutMs);
}

export function waitForRowLockWaiter(db: LockWaiterDb, timeoutMs = 3000): Promise<void> {
  return waitForLockWaiter(db, sql`l.locktype = 'transactionid'`, timeoutMs);
}

export function waitForTableLockWaiter(
  db: LockWaiterDb,
  table: PgTable,
  timeoutMs = 3000,
): Promise<void> {
  return waitForLockWaiter(
    db,
    sql`l.locktype = 'relation' and l.relation = ${getTableName(table)}::regclass`,
    timeoutMs,
  );
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

export function testDatabasePrefix(): string {
  const runId = process.env['OPENORA_TEST_RUN_ID'];
  if (!runId) {
    throw new Error('OPENORA_TEST_RUN_ID is not set - this tier requires its global setup');
  }
  return `test_${runId}_`;
}

export const adminDatabaseUrl = (): string => ADMIN_DATABASE_URL;

export type Migration = (databaseUrl: string) => Promise<unknown>;

export type TestDb = {
  url: string;
  drizzle: DrizzleService;
  drop: () => Promise<void>;
};

export async function createTestDb(migrations: Migration[]): Promise<TestDb> {
  const database = `${testDatabasePrefix()}${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: ADMIN_DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
  } catch (err) {
    if (isConnectionError(err)) {
      throw new Error(INFRA_HINT, { cause: err });
    }
    throw err;
  } finally {
    await admin.end();
  }

  const url = withDatabase(ADMIN_DATABASE_URL, database);
  for (const migrate of migrations) {
    await migrate(url);
  }

  process.env['DATABASE_URL'] = url;
  const drizzle = new DrizzleService();

  return {
    url,
    drizzle,
    async drop(): Promise<void> {
      await drizzle.dispose();
    },
  };
}

export type TestRedis = {
  client: ReturnType<typeof createClient>;
  flush: () => Promise<void>;
  quit: () => Promise<void>;
};

export async function createTestRedis(): Promise<TestRedis> {
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
