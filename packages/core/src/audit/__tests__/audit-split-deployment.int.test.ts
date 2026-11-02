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
const savedEnv = {
  redis: process.env['REDIS_URL'],
  name: process.env['SERVICE_NAME'],
  namespace: process.env['REALTIME_NAMESPACE'],
};

// One service of a split deployment: its own createApp, so its own Redis connections and its
// own default consumer group, over the shared Redis and database. Services of one deployment
// share a realtime namespace; another deployment on the same Redis uses its own.
async function bootService(
  serviceName: string,
  namespace: string,
  noRoutes = false,
): Promise<Service> {
  process.env['REDIS_URL'] = redisUrlForWorker();
  process.env['SERVICE_NAME'] = serviceName;
  process.env['REALTIME_NAMESPACE'] = namespace;
  const service = await createApp(
    {
      plugins: [
        { id: 'audit', path: fileURLToPath(new URL('../plugin.ts', import.meta.url)), noRoutes },
      ],
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
    ['REALTIME_NAMESPACE', savedEnv.namespace],
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
  it('still writes the audit row when the module is loaded without its routes', async () => {
    // Runs first and stops its service and drops its group, so its deployment leaves no group or
    // row-writer behind for the tests below.
    // The audit service is built inside its router factory; withholding the routes must not skip it.
    const namespace = `deploy-${randomUUID()}`;
    const service = await bootService(`svc-a-${randomUUID()}`, namespace, true);
    await vi.waitFor(
      async () =>
        expect((await redis.client.xInfoGroups('oss:evt:tag.created')).length).toBeGreaterThan(0),
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const marker = randomUUID();
    service.container
      .get(EVENT_BUS)
      .emit('tag.created', { key: 'vip', isSticky: false, actorId: marker });

    await vi.waitFor(
      async () => {
        const { rows } = await db.drizzle.db.execute<{ rows: number }>(
          sql`select count(*)::int as rows from audit_log
              where action = 'tag.created' and after->>'actorId' = ${marker}`,
        );
        expect(rows[0]?.rows).toBe(1);
      },
      { timeout: 10_000 },
    );
    await service.close();
    await redis.client.xGroupDestroy('oss:evt:tag.created', `${namespace}/audit`);
  });

  it('writes exactly one audit row per event', async () => {
    const namespace = `deploy-${randomUUID()}`;
    const first = await bootService(`svc-a-${randomUUID()}`, namespace);
    await bootService(`svc-b-${randomUUID()}`, namespace);
    // Each service creates its group when it starts reading; events published before that
    // are missed, so wait until every group the deployment will have exists.
    await vi.waitFor(
      async () =>
        expect((await redis.client.xInfoGroups('oss:evt:tag.created')).length).toBeGreaterThan(0),
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    const markers: string[] = Array.from({ length: 10 }, () => randomUUID());
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
      return new Map(
        rows.filter((row) => markers.includes(row.marker)).map((row) => [row.marker, row.rows]),
      );
    };
    await vi.waitFor(async () => expect((await rowsPerMarker()).size).toBe(markers.length), {
      timeout: 10_000,
    });
    // A second copy would land on the other service's group shortly after the first row.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(await rowsPerMarker()).toEqual(new Map(markers.map((marker) => [marker, 1])));
    const groups = await redis.client.xInfoGroups('oss:evt:tag.created');
    expect(groups.map((group) => group.name)).toEqual([`${namespace}/audit`]);
    // The dedup key names the plugin and topic only, so a redelivery on either service dedupes.
    const { rows: consumers } = await db.drizzle.db.execute<{ consumer: string }>(
      sql`select distinct consumer from processed_events where consumer like '%audit/tag.created%'`,
    );
    expect(consumers.map((row) => row.consumer)).toEqual(['audit/tag.created']);
  });

  it('gives each deployment on one Redis its own audit group', async () => {
    const nsA = `deploy-${randomUUID()}`;
    const nsB = `deploy-${randomUUID()}`;
    await bootService(`svc-a-${randomUUID()}`, nsA);
    await bootService(`svc-b-${randomUUID()}`, nsB);
    await vi.waitFor(
      async () => {
        const names = (await redis.client.xInfoGroups('oss:evt:tag.created')).map((g) => g.name);
        expect(names).toEqual(expect.arrayContaining([`${nsA}/audit`, `${nsB}/audit`]));
      },
      { timeout: 10_000 },
    );
  });
});
