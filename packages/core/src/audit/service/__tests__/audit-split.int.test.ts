import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { IDENTITY_READER, type IdentityReader } from '@openora/core/contracts';
import { migrate as migrateOutbox } from '@openora/core/server/migrate';
import { createApp, EVENT_BUS } from '@openora/core/server';
import {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  type TestDb,
  type TestRedis,
} from '../../../testing/real-infra.js';
import { migrate } from '../../migrate.js';
import { drainAuditOutbox } from '../audit-shipper.service.js';

type Service = Awaited<ReturnType<typeof createApp>>;

const unknownPlayer: IdentityReader = {
  getLastLoginAt: async () => null,
  getPlayerIdsInactiveSince: async () => [],
  getPlayerIdByUserId: async () => null,
  getPlayerIdByUserIdSafe: async () => null,
  getPlayerIdsByUserIdsSafe: async () => new Map(),
  getPlayerKycStatusByUserId: async () => null,
  getPlayerUserIdsSharingLoginIp: async () => [],
  canReceiveLoginWithdrawalAlerts: async () => false,
  getPlayerDateOfBirthByUserId: async () => null,
};

const ENV_KEYS = ['REDIS_URL', 'SERVICE_NAME', 'REALTIME_NAMESPACE'] as const;
const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
const services: Service[] = [];
let db: TestDb;
let redis: TestRedis;

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
        {
          id: 'audit',
          path: fileURLToPath(new URL('../../plugin.ts', import.meta.url)),
          noRoutes,
        },
      ],
      databaseUrl: db.url,
    },
    (container) => {
      container.register(IDENTITY_READER, () => unknownPlayer);
    },
  );
  services.push(service);
  return service;
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDb([migrateOutbox, migrate]), createTestRedis()]);
});

afterAll(async () => {
  for (const service of services.splice(0)) {
    await service.close().catch(() => {});
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await redis.flush();
  await Promise.all([db.drop(), redis.quit()]);
});

describe('audit on a split deployment', () => {
  it('leaves the audit rows to the service that selects the module', async () => {
    const namespace = `deploy-${randomUUID()}`;
    const group = `${namespace}/audit`;
    const groupNames = async () =>
      (await redis.client.xInfoGroups('oss:evt:tag.created').catch(() => [])).map((g) => g.name);
    const consumers = async () =>
      (await redis.client.xInfoConsumers('oss:evt:tag.created', group)).length;

    const dependent = await bootService(`svc-a-${randomUUID()}`, namespace, true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await groupNames()).not.toContain(group);

    const selecting = await bootService(`svc-b-${randomUUID()}`, namespace);
    await vi.waitFor(async () => expect(await groupNames()).toContain(group), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await consumers()).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await consumers()).toBe(1);

    const marker = randomUUID();
    dependent.container
      .get(EVENT_BUS)
      .emit('tag.created', { key: 'vip', isSticky: false, actorId: marker });

    await vi.waitFor(
      async () => {
        await drainAuditOutbox(db.drizzle.db);
        const { rows } = await db.drizzle.db.execute<{ rows: number }>(
          sql`select count(*)::int as rows from audit_log
              where action = 'tag.created' and after->>'actorId' = ${marker}`,
        );
        expect(rows[0]?.rows).toBe(1);
      },
      { timeout: 10_000 },
    );
    await Promise.all([dependent.close(), selecting.close()]);
    await redis.client.xGroupDestroy('oss:evt:tag.created', group);
  });
});
