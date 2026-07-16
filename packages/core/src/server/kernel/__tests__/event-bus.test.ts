import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { MessageBrokerAdapter, BrokerHandler, EventEnvelope } from '@openora/core/contracts';
import { mock } from '../../../testing/mock.js';
import { RedisStreamsBroker } from '../redis-streams-broker.js';
import { createEventBus } from '../event-bus.js';
import { createTestRedis, waitForConsumerGroup, type TestRedis } from '@openora/core/testing';

const DELIVERY = { timeout: 5000, interval: 20 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeLogger(): Logger {
  return mock<Logger>({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
}

let redis: TestRedis;
const brokers: RedisStreamsBroker[] = [];

// Each test gets a unique service name (= consumer group) so the fixed domain topics
// don't collide across tests sharing the per-worker Redis.
function realBus(logger: Logger): { bus: ReturnType<typeof createEventBus>; serviceName: string } {
  const serviceName = `evt-${randomUUID()}`;
  const broker = new RedisStreamsBroker(redis.client, { serviceName });
  brokers.push(broker);
  return { bus: createEventBus(broker, logger), serviceName };
}

const streamOf = (topic: string): string => `oss:evt:${topic}`;

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

describe('createEventBus over Redis Streams', () => {
  it('round-trips a known event from emit to a subscriber', async () => {
    const { bus, serviceName } = realBus(fakeLogger());
    const received: unknown[] = [];
    bus.on('wallet.deposit.completed', (p) => {
      received.push(p);
    });
    await waitForConsumerGroup(redis.client, streamOf('wallet.deposit.completed'), serviceName);

    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: '50',
      currency: 'USD',
      transactionId: 'tx1',
    });

    await vi.waitFor(
      () =>
        expect(received).toEqual([
          { userId: 'u1', amount: '50', currency: 'USD', transactionId: 'tx1' },
        ]),
      DELIVERY,
    );
  });

  it('delivers the envelope as the optional second arg to handlers', async () => {
    const { bus, serviceName } = realBus(fakeLogger());
    const envelopes: Array<EventEnvelope | undefined> = [];
    bus.on('wallet.deposit.completed', (_payload, envelope) => {
      envelopes.push(envelope);
    });
    await waitForConsumerGroup(redis.client, streamOf('wallet.deposit.completed'), serviceName);

    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: '10',
      currency: 'USD',
      transactionId: 'tx2',
    });

    await vi.waitFor(() => expect(envelopes).toHaveLength(1), DELIVERY);
    const env = envelopes[0];
    expect(typeof env?.eventId).toBe('string');
    expect(env?.eventId).toHaveLength(36);
    expect(env?.topic).toBe('wallet.deposit.completed');
    expect(env?.schemaVersion).toBe(2);
    expect(typeof env?.occurredAt).toBe('string');
  });

  it('envelope eventId is unique per emission', async () => {
    const { bus, serviceName } = realBus(fakeLogger());
    const ids: string[] = [];
    bus.on('wallet.deposit.completed', (_p, env) => {
      if (env?.eventId) {
        ids.push(env.eventId);
      }
    });
    await waitForConsumerGroup(redis.client, streamOf('wallet.deposit.completed'), serviceName);

    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: '1',
      currency: 'USD',
      transactionId: 'a',
    });
    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: '2',
      currency: 'USD',
      transactionId: 'b',
    });

    await vi.waitFor(() => expect(ids).toHaveLength(2), DELIVERY);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('isolates a throwing subscriber so siblings still run, and logs the failure', async () => {
    const logger = fakeLogger();
    const { bus, serviceName } = realBus(logger);
    const order: string[] = [];
    bus.on('identity.user.registered', () => {
      order.push('first');
      throw new Error('boom');
    });
    bus.on('identity.user.registered', () => {
      order.push('second');
    });
    await waitForConsumerGroup(redis.client, streamOf('identity.user.registered'), serviceName);

    bus.emit('identity.user.registered', { userId: 'u1' });

    await vi.waitFor(() => expect(order).toEqual(['first', 'second']), DELIVERY);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.user.registered' }),
      'event subscriber threw',
    );
  });

  it('logs a validation error for a bad payload but still delivers', async () => {
    const logger = fakeLogger();
    const { bus, serviceName } = realBus(logger);
    const received: unknown[] = [];
    bus.on('identity.user.registered', (p) => {
      received.push(p);
    });
    await waitForConsumerGroup(redis.client, streamOf('identity.user.registered'), serviceName);

    bus.emit('identity.user.registered', { userId: 123 } as never);

    await vi.waitFor(() => expect(received).toHaveLength(1), DELIVERY);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.user.registered' }),
      'event payload failed validation',
    );
  });

  it('logs a rejected async publish instead of an unhandled rejection', async () => {
    const logger = fakeLogger();
    const rejectingBroker: MessageBrokerAdapter = {
      publish: () => Promise.reject(new Error('broker down')),
      subscribe: (_topic: string, _handler: BrokerHandler) => () => undefined,
      close: async () => undefined,
    };
    const bus = createEventBus(rejectingBroker, logger);

    bus.emit('gaming.round.ended', { roundId: 'r1', userId: 'u1' });
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'gaming.round.ended', err: expect.any(Error) }),
      'event publish failed',
    );
  });

  it('delegates transport to the bound broker (the swap seam)', () => {
    const published: Array<EventEnvelope> = [];
    const fakeBroker: MessageBrokerAdapter = {
      publish: (envelope: EventEnvelope) => {
        published.push(envelope);
      },
      subscribe: (_topic: string, _handler: BrokerHandler) => () => undefined,
      close: async () => undefined,
    };
    const bus = createEventBus(fakeBroker, fakeLogger());

    bus.emit('gaming.round.ended', { roundId: 'r1', userId: 'u1' });

    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe('gaming.round.ended');
    expect(published[0]?.payload).toEqual({ roundId: 'r1', userId: 'u1' });
    expect(typeof published[0]?.eventId).toBe('string');
  });
});
