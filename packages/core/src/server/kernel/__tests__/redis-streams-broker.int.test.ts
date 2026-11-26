import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@openora/core/contracts';
import {
  createTestRedis,
  waitForConsumerGroup,
  type TestRedis,
} from '../../../testing/real-infra.js';
import { EVENT_RETENTION_MS } from '../event-bus.js';
import { RedisStreamsBroker } from '../redis-streams-broker.js';

const loggerCalls = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ ...loggerCalls, info: vi.fn(), debug: vi.fn() }),
}));

const FAST_RECLAIM = { intervalMs: 50, minIdleMs: 50 };

let redis: TestRedis;
const brokers: RedisStreamsBroker[] = [];

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  loggerCalls.error.mockClear();
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

afterAll(async () => {
  await redis.quit();
});

const newBroker = (options: ConstructorParameters<typeof RedisStreamsBroker>[1]) => {
  const broker = new RedisStreamsBroker(redis.client, options);
  brokers.push(broker);
  return broker;
};

const newTopic = () => `broker.test.${randomUUID()}`;
const newGroup = () => `svc-${randomUUID()}`;
const streamOf = (topic: string) => `oss:evt:${topic}`;
const dlqOf = (topic: string) => `oss:dlq:${topic}`;

const envelope = (topic: string, overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  eventId: randomUUID(),
  topic,
  payload: { note: randomUUID() },
  occurredAt: new Date().toISOString(),
  schemaVersion: 1,
  ...overrides,
});

const settle = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pendingCount = async (topic: string, group: string) =>
  (await redis.client.xPending(streamOf(topic), group)).pending;

const deadLetterEntries = (topic: string) => redis.client.xRange(dlqOf(topic), '-', '+');

async function subscribed(
  broker: RedisStreamsBroker,
  topic: string,
  group: string,
  handler: (item: EventEnvelope) => void | Promise<void>,
) {
  broker.subscribe(topic, handler);
  await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group });
}

describe('publish and consume', () => {
  it('a published event reaches every consumer group once', async () => {
    const topic = newTopic();
    const groupA = newGroup();
    const groupB = newGroup();
    const received = { a1: 0, a2: 0, b: 0 };
    const replicaA1 = newBroker({ serviceName: groupA });
    const replicaA2 = newBroker({ serviceName: groupA });
    const serviceB = newBroker({ serviceName: groupB });
    await subscribed(replicaA1, topic, groupA, () => void (received.a1 += 1));
    await subscribed(replicaA2, topic, groupA, () => void (received.a2 += 1));
    await subscribed(serviceB, topic, groupB, () => void (received.b += 1));
    await replicaA1.publish(envelope(topic));
    await vi.waitFor(() => {
      expect(received.a1 + received.a2).toBe(1);
      expect(received.b).toBe(1);
    });
    await settle();
    expect(received.a1 + received.a2).toBe(1);
    expect(received.b).toBe(1);
  });

  it('every local handler runs even when a sibling handler throws', async () => {
    const topic = newTopic();
    const group = newGroup();
    const broker = newBroker({ serviceName: group });
    const ran: string[] = [];
    broker.subscribe(topic, () => {
      ran.push('failing');
      throw new Error('first handler failed');
    });
    broker.subscribe(topic, () => void ran.push('sibling'));
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group });
    await broker.publish(envelope(topic));
    await vi.waitFor(() => expect([...ran].sort()).toEqual(['failing', 'sibling']));
    expect(await pendingCount(topic, group)).toBe(1);
  });

  it('an entry is acknowledged after handlers succeed', async () => {
    const topic = newTopic();
    const group = newGroup();
    const broker = newBroker({ serviceName: group });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    await subscribed(broker, topic, group, async () => {
      entered = true;
      await gate;
    });
    await broker.publish(envelope(topic));
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await pendingCount(topic, group)).toBe(1);
    release();
    await vi.waitFor(async () => expect(await pendingCount(topic, group)).toBe(0));
  });
});

describe('retry and dead-letter', () => {
  async function deadLetterAfterFailures(topic: string, group: string) {
    const calls: EventEnvelope[] = [];
    const broker = newBroker({ serviceName: group, reclaim: FAST_RECLAIM });
    await subscribed(broker, topic, group, (item) => {
      calls.push(item);
      throw new Error('handler always fails');
    });
    const published = envelope(topic);
    await broker.publish(published);
    await vi.waitFor(async () => expect(await deadLetterEntries(topic)).toHaveLength(1), {
      timeout: 15_000,
    });
    return { calls, published, broker };
  }

  it('a failing entry is retried until the max delivery count then moved to the dead-letter stream', async () => {
    const topic = newTopic();
    const group = newGroup();
    const { calls, published } = await deadLetterAfterFailures(topic, group);
    expect(calls).toHaveLength(5);
    expect(calls.every((item) => item.eventId === published.eventId)).toBe(true);
    await vi.waitFor(async () => expect(await pendingCount(topic, group)).toBe(0));
    await settle();
    expect(calls).toHaveLength(5);
    expect(await deadLetterEntries(topic)).toHaveLength(1);
  });

  it('a dead-lettered entry keeps its payload, error and delivery count', async () => {
    const topic = newTopic();
    const group = newGroup();
    const { published } = await deadLetterAfterFailures(topic, group);
    const [entry] = await deadLetterEntries(topic);
    expect(entry?.message['data']).toBe(JSON.stringify(published));
    expect(entry?.message['error']).toBe('handler always fails');
    expect(entry?.message['deliveries']).toBe('5');
    expect(entry?.message['group']).toBe(group);
    const [source] = await redis.client.xRange(streamOf(topic), '-', '+');
    expect(entry?.message['streamId']).toBe(source?.id);
  });

  it('an idle pending entry is reclaimed by another consumer', async () => {
    const topic = newTopic();
    const group = newGroup();
    const crashed = newBroker({ serviceName: group });
    await subscribed(crashed, topic, group, () => {
      throw new Error('replica went down mid-handler');
    });
    const published = envelope(topic);
    await crashed.publish(published);
    await vi.waitFor(async () => expect(await pendingCount(topic, group)).toBe(1));
    const [before] = await redis.client.xPendingRange(streamOf(topic), group, '-', '+', 10);
    await crashed.close();
    const survivor = newBroker({ serviceName: group, reclaim: FAST_RECLAIM });
    const received: EventEnvelope[] = [];
    survivor.subscribe(topic, (item) => void received.push(item));
    await vi.waitFor(() => expect(received).toEqual([published]));
    await vi.waitFor(async () => expect(await pendingCount(topic, group)).toBe(0));
    expect(before?.consumer).toBeDefined();
    expect(before?.deliveriesCounter).toBe(1);
    expect(await deadLetterEntries(topic)).toEqual([]);
  });

  it('an entry pending past the retention window is dead-lettered without a handler run', async () => {
    const topic = newTopic();
    const group = newGroup();
    const key = streamOf(topic);
    const staleId = `${Date.now() - EVENT_RETENTION_MS - 60_000}-0`;
    const stale = envelope(topic);
    await redis.client.xGroupCreate(key, group, '0', { MKSTREAM: true });
    await redis.client.xAdd(key, staleId, { data: JSON.stringify(stale) });
    await redis.client.xReadGroup(group, 'ghost-consumer', { key, id: '>' }, { COUNT: 1 });
    expect(await pendingCount(topic, group)).toBe(1);
    const calls: EventEnvelope[] = [];
    const broker = newBroker({ serviceName: group, reclaim: FAST_RECLAIM });
    broker.subscribe(topic, (item) => void calls.push(item));
    await vi.waitFor(async () => expect(await deadLetterEntries(topic)).toHaveLength(1));
    const [entry] = await deadLetterEntries(topic);
    expect(entry?.message['data']).toBe(JSON.stringify(stale));
    expect(entry?.message['error']).toBe('pending past the event retention window');
    expect(entry?.message['streamId']).toBe(staleId);
    await vi.waitFor(async () => expect(await pendingCount(topic, group)).toBe(0));
    await settle();
    expect(calls).toEqual([]);
  });

  it('the dead-letter stream is never trimmed', async () => {
    const topic = newTopic();
    const group = newGroup();
    const ancientIds = [30, 20].map((days) => `${Date.now() - days * 24 * 60 * 60_000}-0`);
    for (const id of ancientIds) {
      await redis.client.xAdd(dlqOf(topic), id, { data: '{}', error: 'old failure' });
    }
    const broker = newBroker({ serviceName: group, startId: '0' });
    await subscribed(broker, topic, group, () => undefined);
    await redis.client.xAdd(streamOf(topic), '*', { data: 'not json' });
    await vi.waitFor(async () => expect(await deadLetterEntries(topic)).toHaveLength(3));
    await broker.publish(envelope(topic));
    await settle();
    const ids = (await deadLetterEntries(topic)).map((entry) => entry.id);
    expect(ids.slice(0, 2)).toEqual(ancientIds);
  });

  it('deadLetters sums the entries of every dead-letter stream and names the newest', async () => {
    const group = newGroup();
    const topics = [newTopic(), newTopic()];
    const before = await newBroker({ serviceName: group }).deadLetters?.();
    const broker = newBroker({ serviceName: group, startId: '0' });
    for (const topic of topics) {
      await subscribed(broker, topic, group, () => undefined);
    }
    const [first, second] = topics;
    if (!first || !second) {
      throw new Error('fixture');
    }
    await redis.client.xAdd(streamOf(first), '*', { data: 'not json' });
    await redis.client.xAdd(streamOf(first), '*', { data: 'also not json' });
    await vi.waitFor(async () => expect(await deadLetterEntries(first)).toHaveLength(2));
    await redis.client.xAdd(streamOf(second), '*', { data: 'still not json' });
    await vi.waitFor(async () => expect(await deadLetterEntries(second)).toHaveLength(1));
    const after = await broker.deadLetters?.();
    expect((after?.count ?? 0) - (before?.count ?? 0)).toBe(3);
    const [newest] = await redis.client.xRevRange(dlqOf(second), '+', '-', { COUNT: 1 });
    expect(after?.newest).toBe(`${dlqOf(second)}/${newest?.id}`);
  });
});

describe('startup', () => {
  it('creating a consumer group that already exists does not fail', async () => {
    const topic = newTopic();
    const group = newGroup();
    await redis.client.xGroupCreate(streamOf(topic), group, '$', { MKSTREAM: true });
    const published = envelope(topic);
    await redis.client.xAdd(streamOf(topic), '*', { data: JSON.stringify(published) });
    const received: EventEnvelope[] = [];
    const broker = newBroker({ serviceName: group, startId: '0' });
    broker.subscribe(topic, (item) => void received.push(item));
    await vi.waitFor(() => expect(received).toEqual([published]));
    await settle();
    expect(received).toEqual([published]);
    expect(
      loggerCalls.error.mock.calls.filter(
        ([, message]) => message === 'stream loop error, retrying',
      ),
    ).toEqual([]);
  });

  it('a stream loop error is logged and the loop continues', async () => {
    const topic = newTopic();
    const group = newGroup();
    const received: EventEnvelope[] = [];
    const broker = newBroker({ serviceName: group, startId: '0' });
    await subscribed(broker, topic, group, (item) => void received.push(item));
    await redis.client.xGroupDestroy(streamOf(topic), group);
    await vi.waitFor(
      () =>
        expect(loggerCalls.error).toHaveBeenCalledWith(
          expect.objectContaining({ key: streamOf(topic), group }),
          'stream loop error, retrying',
        ),
      { timeout: 10_000 },
    );
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group, timeoutMs: 10_000 });
    const published = envelope(topic);
    await broker.publish(published);
    await vi.waitFor(() => expect(received).toEqual([published]), { timeout: 10_000 });
  });
});
