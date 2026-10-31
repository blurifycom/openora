import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  waitForConsumerGroup,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { createApp } from '../create-app.js';
import { EVENT_BUS } from '../../kernel/index.js';
import { PER_SERVICE_TOPIC, heardByService } from './fixtures/per-service-listener-plugin.js';

const IDENTITY_ENV = ['SERVICE_NAME', 'REALTIME_NAMESPACE', 'REDIS_URL'];
const pluginPath = fileURLToPath(
  new URL('./fixtures/per-service-listener-plugin.ts', import.meta.url),
);

type Service = Awaited<ReturnType<typeof createApp>>;

let db: TestDb;
let redis: TestRedis;
const services: Service[] = [];
const savedEnv = Object.fromEntries(IDENTITY_ENV.map((key) => [key, process.env[key]]));

async function boot(name: string, namespace: string): Promise<Service> {
  process.env['REDIS_URL'] = redisUrlForWorker();
  process.env['SERVICE_NAME'] = name;
  process.env['REALTIME_NAMESPACE'] = namespace;
  const service = await createApp({
    plugins: [{ id: 'per-service-listener', path: pluginPath }],
    databaseUrl: db.url,
  });
  services.push(service);
  return service;
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDb([migrateOutbox]), createTestRedis()]);
});

afterAll(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await redis.flush();
  await Promise.all([db.drop(), redis.quit()]);
});

describe('a plugin handler outside a shared consumer group, in two services of one deployment', () => {
  it('runs in each service, under a dedup identity that names the service', async () => {
    const namespace = `deploy-${randomUUID()}`;
    const nameA = `svc-a-${randomUUID()}`;
    const nameB = `svc-b-${randomUUID()}`;
    const a = await boot(nameA, namespace);
    await boot(nameB, namespace);
    const stream = `oss:evt:${PER_SERVICE_TOPIC}`;
    await waitForConsumerGroup(redis.client, { stream, group: nameA });
    await waitForConsumerGroup(redis.client, { stream, group: nameB });

    a.container.get(EVENT_BUS).emitRaw(PER_SERVICE_TOPIC, { n: 1 });

    const consumers = async (): Promise<string[]> => {
      const { rows } = await db.drizzle.db.execute<{ consumer: string }>(
        sql`select consumer from processed_events order by consumer`,
      );
      return rows.map((row) => row.consumer);
    };
    // A shared identity would let the first service's processed row skip the other's handler.
    await vi.waitFor(
      async () =>
        expect(await consumers()).toEqual([
          `${nameA}/per-service-listener/${PER_SERVICE_TOPIC}`,
          `${nameB}/per-service-listener/${PER_SERVICE_TOPIC}`,
        ]),
      { timeout: 10_000 },
    );
    expect([...heardByService()].sort()).toEqual([nameA, nameB]);
  });
});
