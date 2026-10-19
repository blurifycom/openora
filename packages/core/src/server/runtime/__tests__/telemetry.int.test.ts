import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { CACHE, JOB_QUEUE, PLAYER_ACTIVITY_TRACKER } from '@openora/core/contracts';
import {
  createTestDb,
  createTestRedis,
  redisUrlForWorker,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';
import { migrate } from '@openora/core/server/migrate';
import { DRIZZLE, openoraInstance } from '../../db/index.js';
import { BullMqJobQueue, Container, RedisCache } from '../../kernel/index.js';
import type { CoreTokenCatalog } from '../core-token-catalog.js';
import { resolveInstanceId, startTelemetry, type TelemetryBody } from '../telemetry.js';

const QUIET_PERIOD_MS = 500;

let db: TestDb;
let redis: TestRedis;
let server: Server;
let collectorUrl: string;
const received: TelemetryBody[] = [];

function makeContainer({ withPlayers = true } = {}) {
  const container = new Container<CoreTokenCatalog>();
  if (withPlayers) {
    container.register(PLAYER_ACTIVITY_TRACKER, () => ({ touchLastSeen: async () => {} }));
  }
  container.register(DRIZZLE, () => db.drizzle);
  container.register(CACHE, () => new RedisCache(redis.client));
  container.register(JOB_QUEUE, () => {
    const q = new BullMqJobQueue(redisUrlForWorker());
    container.onDispose(() => q.close());
    return q;
  });
  return container;
}

function eventsNamed(name: string) {
  return received.filter((b) => b.payload.name === name);
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  redis = await createTestRedis();
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  collectorUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/send`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await redis.quit();
  await db.drop();
});

beforeEach(async () => {
  received.length = 0;
  await redis.flush();
});

describe('resolveInstanceId', () => {
  it('returns one stable id however many replicas race for it', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => resolveInstanceId(db.drizzle)));

    expect(new Set(ids).size).toBe(1);
    expect(await resolveInstanceId(db.drizzle)).toBe(ids[0]);
    expect(await db.drizzle.db.select().from(openoraInstance)).toHaveLength(1);
  });
});

describe('startTelemetry', () => {
  let containers: Container<CoreTokenCatalog>[] = [];

  afterEach(async () => {
    await Promise.all(containers.map((c) => c.dispose()));
    containers = [];
  });

  function boot(
    option: false | undefined,
    overrides: Record<string, string> = {},
    { withPlayers = true } = {},
  ) {
    const container = makeContainer({ withPlayers });
    containers.push(container);
    startTelemetry(container, option, {
      NODE_ENV: 'production',
      OPENORA_TELEMETRY_URL: collectorUrl,
      ...overrides,
    });
  }

  it('sends one boot event per hour however many times the server starts', async () => {
    boot(undefined);
    boot(undefined);

    await vi.waitFor(() => expect(eventsNamed('boot')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, QUIET_PERIOD_MS));
    expect(eventsNamed('boot')).toHaveLength(1);
    expect(eventsNamed('boot')[0]?.payload.id).toBe(await resolveInstanceId(db.drizzle));
  });

  it('runs the daily heartbeat from the job scheduler', async () => {
    boot(undefined);

    await vi.waitFor(() => expect(eventsNamed('heartbeat')).toHaveLength(1), { timeout: 5000 });
    expect(eventsNamed('heartbeat')[0]?.payload.data.activePlayers1d).toBeNull();
  });

  it('sends nothing when opted out', async () => {
    boot(false);
    boot(undefined, { OPENORA_TELEMETRY_DISABLED: '1' });
    boot(undefined, { DO_NOT_TRACK: '1' });

    await new Promise((resolve) => setTimeout(resolve, QUIET_PERIOD_MS));
    expect(received).toHaveLength(0);
  });

  it('removes the daily heartbeat when a later boot opts out', async () => {
    const raw = new Queue('telemetry', {
      connection: { url: redisUrlForWorker(), maxRetriesPerRequest: null },
    });
    try {
      boot(undefined);
      await vi.waitFor(async () => expect(await raw.getJobSchedulers()).toHaveLength(1));

      boot(undefined, { OPENORA_TELEMETRY_DISABLED: '1' });
      await vi.waitFor(async () => expect(await raw.getJobSchedulers()).toHaveLength(0));
    } finally {
      await raw.close();
    }
  });

  it('leaves reporting to the service that owns players', async () => {
    boot(undefined, {}, { withPlayers: false });

    await new Promise((resolve) => setTimeout(resolve, QUIET_PERIOD_MS));
    expect(received).toHaveLength(0);
  });
});
