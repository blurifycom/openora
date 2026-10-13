import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MAX_DELIVERIES, RedisStreamsBroker } from '../redis-streams-broker.js';
import { createTestRedis, waitForConsumerGroup, type TestRedis } from '@openora/core/testing';
import type { EventEnvelope } from '@openora/core/contracts';

let redis: TestRedis;
const brokers: RedisStreamsBroker[] = [];

// Reclaim fast so redelivery tests don't wait out the production idle window.
const FAST_RECLAIM = { intervalMs: 20, minIdleMs: 10 };

function makeBroker(
  serviceName: string,
  reclaim?: { intervalMs: number; minIdleMs: number },
): RedisStreamsBroker {
  const broker = new RedisStreamsBroker(redis.client, {
    serviceName,
    ...(reclaim ? { reclaim } : {}),
  });
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

  it('trims entries older than the retention window on publish', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const ancientEntryCount = 300;
    const seed = redis.client.multi();
    for (let i = 1; i <= ancientEntryCount; i++) {
      seed.xAdd(streamOf(topic), `${i}-0`, { data: 'ancient' });
    }
    await seed.exec();

    await broker.publish(makeEnvelope(topic));

    const remaining = await redis.client.xRange(streamOf(topic), '-', '+');
    expect(remaining.length).toBeLessThan(ancientEntryCount);
    expect(remaining.at(-1)!.message['data']).not.toBe('ancient');
  });

  it('keeps recent entries past the old 10,000-entry cap', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const recentEntryCount = 10_200;
    const seed = redis.client.multi();
    for (let i = 0; i < recentEntryCount; i++) {
      seed.xAdd(streamOf(topic), '*', { data: 'recent' });
    }
    await seed.exec();

    await broker.publish(makeEnvelope(topic));

    expect(await redis.client.xLen(streamOf(topic))).toBe(recentEntryCount + 1);
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

  it('recovers on its own after the stream key (and its group) disappear', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const seen: EventEnvelope[] = [];
    broker.subscribe(topic, (e) => {
      seen.push(e);
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    await redis.client.del(streamOf(topic));

    await waitForConsumerGroup(redis.client, {
      stream: streamOf(topic),
      group: 'svc',
      timeoutMs: 6000,
    });

    const envelope = makeEnvelope(topic);
    await broker.publish(envelope);

    await vi.waitFor(() => expect(seen).toEqual([envelope]), { timeout: 5000 });
  });

  it('leaves a failed entry pending and redelivers it until the handler succeeds', async () => {
    const broker = makeBroker('svc', FAST_RECLAIM);
    const topic = uniqueTopic();
    let attempts = 0;
    broker.subscribe(topic, () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient');
      }
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    await broker.publish(makeEnvelope(topic));

    await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 5000 });
    await vi.waitFor(async () => {
      const pending = await redis.client.xPending(streamOf(topic), 'svc');
      expect(pending.pending).toBe(0);
    });
    expect(await redis.client.exists(`oss:dlq:${topic}`)).toBe(0);
  });

  it('reclaims the whole pending backlog in one pass, not one page', async () => {
    const broker = makeBroker('svc', { intervalMs: 1000, minIdleMs: 10 });
    const topic = uniqueTopic();
    const seen = new Set<string>();
    let handled = 0;
    broker.subscribe(topic, (envelope) => {
      if (!seen.has(envelope.eventId)) {
        seen.add(envelope.eventId);
        throw new Error('transient');
      }
      handled += 1;
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    // 25 entries span three XAUTOCLAIM pages (COUNT 10); the next pass would be ~1s later.
    for (let i = 0; i < 25; i += 1) {
      await broker.publish(makeEnvelope(topic));
    }

    await vi.waitFor(() => expect(handled).toBe(25), { timeout: 1800 });
  });

  it(`dead-letters an entry still failing after ${MAX_DELIVERIES} deliveries and ACKs it`, async () => {
    const broker = makeBroker('svc', FAST_RECLAIM);
    const topic = uniqueTopic();
    let attempts = 0;
    broker.subscribe(topic, () => {
      attempts += 1;
      throw new Error('poison');
    });
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    const envelope = makeEnvelope(topic);
    await broker.publish(envelope);

    await vi.waitFor(async () => expect(await redis.client.xLen(`oss:dlq:${topic}`)).toBe(1), {
      timeout: 5000,
    });
    expect(attempts).toBe(MAX_DELIVERIES);
    const [dead] = await redis.client.xRange(`oss:dlq:${topic}`, '-', '+');
    expect(JSON.parse(dead!.message['data']!)).toEqual(envelope);
    expect(dead!.message).toMatchObject({
      group: 'svc',
      deliveries: String(MAX_DELIVERIES),
      error: 'poison',
    });
    const pending = await redis.client.xPending(streamOf(topic), 'svc');
    expect(pending.pending).toBe(0);
  });

  it('dead-letters an entry that is not valid JSON without calling handlers', async () => {
    const broker = makeBroker('svc');
    const topic = uniqueTopic();
    const handler = vi.fn();
    broker.subscribe(topic, handler);
    await waitForConsumerGroup(redis.client, { stream: streamOf(topic), group: 'svc' });

    await redis.client.xAdd(streamOf(topic), '*', { data: '{not json' });

    await vi.waitFor(async () => expect(await redis.client.xLen(`oss:dlq:${topic}`)).toBe(1));
    expect(handler).not.toHaveBeenCalled();
  });
});
