import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import {
  ACCESS_REVOKED_SIGNAL,
  REALTIME_TRANSPORT,
  type RealtimeSignal,
} from '@openora/core/contracts';
import {
  createTestRedis,
  redisUrlForWorker,
  waitForConsumerGroup,
  type TestRedis,
} from '@openora/core/testing';
import { createApp } from '../create-app.js';
import { EVENT_BUS } from '../../kernel/index.js';

// Two services of one deployment are two createApp calls against the same Redis, each with
// its own connections, which is what two processes have. Nothing is wired by hand: the
// service name and realtime namespace come from the environment exactly as in production.
const DUMMY_DATABASE_URL = 'postgres://test:test@127.0.0.1:1/service_identity_test';
const IDENTITY_ENV = ['SERVICE_NAME', 'REALTIME_NAMESPACE', 'SERVICE_MANIFEST', 'REDIS_URL'];

type Service = Awaited<ReturnType<typeof createApp>>;

let redis: TestRedis;
const services: Service[] = [];
const savedEnv = Object.fromEntries(IDENTITY_ENV.map((key) => [key, process.env[key]]));

async function boot(identity: { name?: string; namespace?: string }): Promise<Service> {
  for (const key of IDENTITY_ENV) {
    delete process.env[key];
  }
  process.env['REDIS_URL'] = redisUrlForWorker();
  if (identity.name) {
    process.env['SERVICE_NAME'] = identity.name;
  }
  if (identity.namespace) {
    process.env['REALTIME_NAMESPACE'] = identity.namespace;
  }
  const service = await createApp({ plugins: [], databaseUrl: DUMMY_DATABASE_URL });
  services.push(service);
  return service;
}

// A fresh name per test, so fixed streams and groups never leak between tests.
const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;

async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function subscribed(counts: Record<string, number>): Promise<void> {
  await vi.waitFor(
    async () => {
      const live = await redis.client.pubSubNumSub(Object.keys(counts));
      for (const [key, count] of Object.entries(counts)) {
        expect(live[key] ?? 0, key).toBeGreaterThanOrEqual(count);
      }
    },
    { timeout: 5000, interval: 10 },
  );
}

const streamOf = (topic: string): string => `oss:evt:${topic}`;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const key of IDENTITY_ENV) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await redis.flush();
});

afterAll(async () => {
  await redis.quit();
});

describe('service identity across two services sharing one Redis', () => {
  it('a publish on one service reaches a subscriber on another that shares its realtime namespace', async () => {
    const namespace = unique('rt');
    const a = await boot({ name: unique('svc-a'), namespace });
    const b = await boot({ name: unique('svc-b'), namespace });
    const channel = `room:${randomUUID()}`;
    const received: unknown[] = [];
    b.container.get(REALTIME_TRANSPORT).subscribe(channel, (event) => received.push(event));
    await subscribed({ [`oss:rt:${namespace}:${channel}`]: 1 });

    await a.container.get(REALTIME_TRANSPORT).publish(channel, { from: 'a' });

    await vi.waitFor(() => expect(received).toEqual([{ from: 'a' }]));
  });

  it('two services with different names each receive their own copy of an event', async () => {
    const namespace = unique('rt');
    const nameA = unique('svc-a');
    const nameB = unique('svc-b');
    const a = await boot({ name: nameA, namespace });
    const b = await boot({ name: nameB, namespace });
    const topic = unique('test.event');
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.container.get(EVENT_BUS).on(topic, (payload) => void seenA.push(payload));
    b.container.get(EVENT_BUS).on(topic, (payload) => void seenB.push(payload));
    // The consumer group is the service name, not the realtime namespace both share.
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: nameA });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: nameB });

    a.container.get(EVENT_BUS).emitRaw(topic, { n: 1 });

    await vi.waitFor(() => {
      expect(seenA).toHaveLength(1);
      expect(seenB).toHaveLength(1);
    });
  });

  it('two services subscribing in the same consumer group split an event instead of each getting one', async () => {
    const a = await boot({ name: unique('svc-a') });
    const b = await boot({ name: unique('svc-b') });
    const topic = unique('test.event');
    const group = unique('shared');
    const delivered: unknown[] = [];
    a.container.get(EVENT_BUS).on(topic, (payload) => void delivered.push(payload), {
      consumerGroup: group,
    });
    b.container.get(EVENT_BUS).on(topic, (payload) => void delivered.push(payload), {
      consumerGroup: group,
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group });

    a.container.get(EVENT_BUS).emitRaw(topic, { n: 1 });

    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await settle();
    expect(delivered).toHaveLength(1);
    const groups = await redis.client.xInfoGroups(streamOf(topic));
    expect(groups.map((g) => g.name)).toEqual([group]);
  });

  it('presence and stream revocation resolve across services', async () => {
    const namespace = unique('rt');
    const a = await boot({ name: unique('svc-a'), namespace });
    const b = await boot({ name: unique('svc-b'), namespace });
    const transportA = a.container.get(REALTIME_TRANSPORT);
    const transportB = b.container.get(REALTIME_TRANSPORT);
    const channel = `room:${randomUUID()}`;

    const signalsA: RealtimeSignal[] = [];
    const signalsB: RealtimeSignal[] = [];
    const messagesA: unknown[] = [];
    const messagesB: unknown[] = [];
    const bystander: unknown[] = [];
    transportA.subscribeSignal?.(channel, (s) => signalsA.push(s), 'player-1');
    transportA.subscribe(channel, (e) => messagesA.push(e), 'player-1');
    transportB.subscribeSignal?.(channel, (s) => signalsB.push(s), 'player-1');
    transportB.subscribe(channel, (e) => messagesB.push(e), 'player-1');
    transportB.subscribe(channel, (e) => bystander.push(e), 'player-2');
    await subscribed({
      [`oss:rt:${namespace}:${channel}`]: 2,
      [`oss:rt:${namespace}:signal:${channel}`]: 2,
      [`oss:rt-revoke:${namespace}`]: 2,
    });

    // Joined once both services are connected: a heartbeat sent before the client is ready is
    // skipped, and the next one is 15s away.
    transportA.presence?.join(channel, 'player-1', 'tab-1');
    await vi.waitFor(async () =>
      expect(await transportB.getOnlineUserIds(channel)).toEqual(['player-1']),
    );

    await transportA.revokeUserFromChannel?.('player-1', channel);

    const revoked: RealtimeSignal = { name: ACCESS_REVOKED_SIGNAL, payload: { channel } };
    await vi.waitFor(() => {
      expect(signalsA).toEqual([revoked]);
      expect(signalsB).toEqual([revoked]);
    });
    await transportA.publish(channel, 'after-revoke');
    await vi.waitFor(() => expect(bystander).toEqual(['after-revoke']));
    expect(messagesA).toEqual([]);
    expect(messagesB).toEqual([]);
  });
});

describe('with neither SERVICE_NAME nor REALTIME_NAMESPACE set', () => {
  it('keeps the monolith consumer group and every realtime key it has always used', async () => {
    const service = await boot({});
    const topic = unique('test.event');
    const channel = `room:${randomUUID()}`;
    const transport = service.container.get(REALTIME_TRANSPORT);

    service.container.get(EVENT_BUS).on(topic, () => undefined);
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'monolith' });
    transport.subscribe(channel, () => undefined);
    transport.subscribeSignal?.(channel, () => undefined);
    transport.presence?.join(channel, 'player-1', 'tab-1');

    await subscribed({
      [`oss:rt:monolith:${channel}`]: 1,
      [`oss:rt:monolith:signal:${channel}`]: 1,
      'oss:rt-revoke:monolith': 1,
    });
    await vi.waitFor(async () =>
      expect(await redis.client.zCard(`oss:rt:presence:monolith:${channel}`)).toBe(1),
    );
    const groups = await redis.client.xInfoGroups(streamOf(topic));
    expect(groups.map((g) => g.name)).toEqual(['monolith']);
  });

  it('prefixes realtime keys with SERVICE_NAME when only that is set', async () => {
    const name = unique('svc');
    const service = await boot({ name });
    const topic = unique('test.event');
    const channel = `room:${randomUUID()}`;
    const transport = service.container.get(REALTIME_TRANSPORT);

    service.container.get(EVENT_BUS).on(topic, () => undefined);
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: name });
    transport.subscribe(channel, () => undefined);
    transport.presence?.join(channel, 'player-1', 'tab-1');

    await subscribed({ [`oss:rt:${name}:${channel}`]: 1, [`oss:rt-revoke:${name}`]: 1 });
    await vi.waitFor(async () =>
      expect(await redis.client.zCard(`oss:rt:presence:${name}:${channel}`)).toBe(1),
    );
  });
});
