import { createClient } from 'redis';

const BASE_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6380';
const INFRA_HINT = 'integration tests need redis - run `docker compose up -d`';

const HIGHEST_DATABASE = 15;
const LOWEST_DATABASE = 8;
const DATABASES_PER_WORKER = 4;

const workerSlice = Math.max(
  0,
  Number(process.env['STRYKER_MUTATOR_WORKER'] ?? 0) +
    Number(process.env['VITEST_POOL_ID'] ?? 1) -
    1,
);
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
