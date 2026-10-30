import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { IDENTITY_READER } from '@openora/core/contracts';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { createApp, EVENT_BUS } from '@openora/core/server';
import {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { makeIdentityReader } from '../../testing/mock.js';
import { migrate } from '../migrate.js';

type Service = Awaited<ReturnType<typeof createApp>>;

let db: TestDb;
let redis: TestRedis;
const services: Service[] = [];
const savedEnv = { redis: process.env['REDIS_URL'], name: process.env['SERVICE_NAME'] };

// One service of a split deployment: its own createApp, so its own Redis connections and its
// own default consumer group, over the shared Redis and database.
async function bootService(serviceName: string): Promise<Service> {
  process.env['REDIS_URL'] = redisUrlForWorker();
  process.env['SERVICE_NAME'] = serviceName;
  const service = await createApp(
    {
      plugins: [{ id: 'audit', path: fileURLToPath(new URL('../plugin.ts', import.meta.url)) }],
      databaseUrl: db.url,
    },
    (container) => {
      container.register(IDENTITY_READER, () => makeIdentityReader());
    },
  );
  services.push(service);
  return service;
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDb([migrateOutbox, migrate]), createTestRedis()]);
});

afterAll(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const [key, value] of [
    ['REDIS_URL', savedEnv.redis],
    ['SERVICE_NAME', savedEnv.name],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await redis.flush();
  await Promise.all([db.drop(), redis.quit()]);
});

describe('audit trail with two services of one deployment up', () => {
  it('writes exactly one audit row per event', async () => {
    const first = await bootService(`svc-a-${randomUUID()}`);
    await bootService(`svc-b-${randomUUID()}`);
    // Each service creates its group when it starts reading; events published before that
    // are missed, so wait until every group the deployment will have exists.
    await vi.waitFor(async () =>
      expect((await redis.client.xInfoGroups('oss:evt:tag.created')).length).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const markers = Array.from({ length: 10 }, () => randomUUID());
    for (const marker of markers) {
      first.container
        .get(EVENT_BUS)
        .emit('tag.created', { key: 'vip', isSticky: false, actorId: marker });
    }

    const rowsPerMarker = async (): Promise<Map<string, number>> => {
      const { rows } = await db.drizzle.db.execute<{ marker: string; rows: number }>(
        sql`select after->>'actorId' as marker, count(*)::int as rows
            from audit_log where action = 'tag.created' group by 1`,
      );
      return new Map(rows.map((row) => [row.marker, row.rows]));
    };
    await vi.waitFor(async () => expect((await rowsPerMarker()).size).toBe(markers.length), {
      timeout: 10_000,
    });
    // A second copy would land on the other service's group shortly after the first row.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(await rowsPerMarker()).toEqual(new Map(markers.map((marker) => [marker, 1])));
    const groups = await redis.client.xInfoGroups('oss:evt:tag.created');
    expect(groups.map((group) => group.name)).toEqual(['audit']);
  });
});
