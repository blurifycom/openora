import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RedisStreamsBroker } from '../redis-streams-broker.js';
import { createTestRedis, waitForConsumerGroup, type TestRedis } from '@openora/core/testing';
import type { EventEnvelope } from '@openora/core/contracts';

let redis: TestRedis;
const brokers: RedisStreamsBroker[] = [];

function makeBroker(serviceName: string): RedisStreamsBroker {
  const broker = new RedisStreamsBroker(redis.client, { serviceName });
  brokers.push(broker);
  return broker;
}

// A fresh topic per test so streams/groups never leak between tests.
function uniqueTopic(): string {
  return `test.${randomUUID()}`;
}

function streamOf(topic: string): string {
  return `oss:evt:${topic}`;
}

function makeEnvelope(topic: string): EventEnvelope {
  return {
    eventId: randomUUID(),
    topic,
    payload: { ok: true },
    occurredAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
  };
}

beforeAll(async () => {
  redis = await createTestRedis();
});

afterEach(async () => {
  await Promise.allSettled(brokers.map((b) => b.close()));
  brokers.length = 0;
  await redis.flush();
});

afterAll(async () => {
  await redis.quit();
});

describe('RedisStreamsBroker', () => {
  it('publish XADDs the serialized envelope to the topic stream', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const envelope = makeEnvelope(topic);

    await broker.publish(envelope);

    const entries = await redis.client.xRange(streamOf(topic), '-', '+');
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.message['data']!)).toEqual(envelope);
  });

  it('coalesces two subscribers on one topic: both receive, the entry is ACKed', async () => {
    const broker = makeBroker('wallet-svc');
    const topic = uniqueTopic();
    const seen1: EventEnvelope[] = [];
    const seen2: EventEnvelope[] = [];
    broker.subscribe(topic, (e) => {
      seen1.push(e);
    });
    broker.subscribe(topic, (e) => {
      seen2.push(e);
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'wallet-svc' });

    const envelope = makeEnvelope(topic);
    await broker.publish(envelope);

    await vi.waitFor(() => {
      expect(seen1).toEqual([envelope]);
      expect(seen2).toEqual([envelope]);
    });
    await vi.waitFor(async () => {
      const pending = await redis.client.xPending(streamOf(topic), 'wallet-svc');
      expect(pending.pending).toBe(0);
    });
  });

  it('uses the service name as the default consumer group', async () => {
    const broker = makeBroker('wallet-svc');
    const topic = uniqueTopic();
    broker.subscribe(topic, () => undefined);
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'wallet-svc' });

    const groups = await redis.client.xInfoGroups(streamOf(topic));
    expect(groups.map((g) => g.name)).toEqual(['wallet-svc']);
  });

  it('opts.consumerGroup starts a second group that also receives the event', async () => {
    const broker = makeBroker('wallet-svc');
    const topic = uniqueTopic();
    const seenDefault: EventEnvelope[] = [];
    const seenCustom: EventEnvelope[] = [];
    broker.subscribe(topic, (e) => {
      seenDefault.push(e);
    });
    broker.subscribe(
      topic,
      (e) => {
        seenCustom.push(e);
      },
      { consumerGroup: 'analytics' },
    );
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'wallet-svc' });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'analytics' });

    const envelope = makeEnvelope(topic);
    await broker.publish(envelope);

    await vi.waitFor(() => {
      expect(seenDefault).toEqual([envelope]);
      expect(seenCustom).toEqual([envelope]);
    });
    const groups = await redis.client.xInfoGroups(streamOf(topic));
    expect(groups.map((g) => g.name).sort()).toEqual(['analytics', 'wallet-svc']);
  });

  it('unsubscribe stops delivery to that handler', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const seen1: EventEnvelope[] = [];
    const seen2: EventEnvelope[] = [];
    const unsubscribe1 = broker.subscribe(topic, (e) => {
      seen1.push(e);
    });
    broker.subscribe(topic, (e) => {
      seen2.push(e);
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    unsubscribe1();

    const envelope = makeEnvelope(topic);
    await broker.publish(envelope);

    await vi.waitFor(() => expect(seen2).toEqual([envelope]));
    expect(seen1).toEqual([]);
  });

  it('close stops the read loop so a later publish is not delivered', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const seen: EventEnvelope[] = [];
    broker.subscribe(topic, (e) => {
      seen.push(e);
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    await broker.close();
    await broker.publish(makeEnvelope(topic));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen).toEqual([]);
    expect(await redis.client.xLen(streamOf(topic))).toBe(1);
  });

  it('two instances sharing a service name split events: exactly one handles each', async () => {
    const topic = uniqueTopic();
    const seenA: EventEnvelope[] = [];
    const seenB: EventEnvelope[] = [];
    makeBroker('svc').subscribe(topic, (e) => {
      seenA.push(e);
    });
    makeBroker('svc').subscribe(topic, (e) => {
      seenB.push(e);
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    const envelope = makeEnvelope(topic);
    await brokers[0]!.publish(envelope);

    await vi.waitFor(() => expect(seenA.length + seenB.length).toBe(1));
    // Give the other instance a beat to (wrongly) double-deliver - it must not.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seenA.length + seenB.length).toBe(1);
  });

  it('two instances with different service names both handle the event', async () => {
    const topic = uniqueTopic();
    const seenA: EventEnvelope[] = [];
    const seenB: EventEnvelope[] = [];
    makeBroker('svc-a').subscribe(topic, (e) => {
      seenA.push(e);
    });
    makeBroker('svc-b').subscribe(topic, (e) => {
      seenB.push(e);
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc-a' });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc-b' });

    const envelope = makeEnvelope(topic);
    await brokers[0]!.publish(envelope);

    await vi.waitFor(() => {
      expect(seenA).toEqual([envelope]);
      expect(seenB).toEqual([envelope]);
    });
  });
});
