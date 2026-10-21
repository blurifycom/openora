import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { MessageBrokerAdapter, BrokerHandler, EventEnvelope } from '@openora/core/contracts';
import { migrate } from '@openora/core/server/migrate';
import { mock } from '../../../testing/mock.js';
import { RedisStreamsBroker } from '../redis-streams-broker.js';
import { createEventBus, type EventBus } from '../event-bus.js';
import { DrizzleOutboxWriter } from '../../db/outbox/writer.js';
import { DrizzleProcessedEventLog } from '../../db/outbox/processed-events.js';
import { OutboxRelay } from '../../db/outbox/relay.js';
import { eventOutbox, processedEvents } from '../../db/outbox/schema.js';
import {
  createTestDb,
  createTestRedis,
  waitForConsumerGroup,
  type TestDb,
  type TestRedis,
} from '@openora/core/testing';

const DELIVERY = { timeout: 5000, interval: 20 };
const FAST_RECLAIM = { intervalMs: 20, minIdleMs: 10 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeLogger(): Logger {
  return mock<Logger>({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
}

let db: TestDb;
let redis: TestRedis;
const brokers: RedisStreamsBroker[] = [];

function busOver(broker: MessageBrokerAdapter, logger: Logger = fakeLogger()): EventBus {
  return createEventBus({
    broker,
    outbox: new DrizzleOutboxWriter(),
    processedEvents: new DrizzleProcessedEventLog(db.drizzle.db),
    logger,
  });
}

// Each test gets a unique service name (= consumer group) so the fixed domain topics
// don't collide across tests sharing the per-worker Redis.
function realBus(logger: Logger = fakeLogger()): {
  bus: EventBus;
  serviceName: string;
  broker: RedisStreamsBroker;
} {
  const serviceName = `evt-${randomUUID()}`;
  const broker = new RedisStreamsBroker(redis.client, { serviceName, reclaim: FAST_RECLAIM });
  brokers.push(broker);
  return { bus: busOver(broker, logger), serviceName, broker };
}

const streamOf = (topic: string): string => `oss:evt:${topic}`;

const USER_ID = randomUUID();

function deposit() {
  return {
    userId: USER_ID,
    playerId: null,
    amount: '50',
    currency: 'USD',
    transactionId: randomUUID(),
  };
}

const roundEnded = () => ({ roundId: randomUUID(), userId: USER_ID, playerId: null });

function envelopeOf(topic: string, payload: unknown): EventEnvelope {
  return {
    eventId: randomUUID(),
    topic,
    payload,
    occurredAt: new Date().toISOString(),
    schemaVersion: 2,
  };
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDb([migrate]), createTestRedis()]);
});

afterEach(async () => {
  await Promise.allSettled(brokers.map((b) => b.close()));
  brokers.length = 0;
  await redis.flush();
  await db.drizzle.db.execute(sql`TRUNCATE ${eventOutbox}, ${processedEvents}`);
});

afterAll(async () => {
  await Promise.all([redis.quit(), db.drop()]);
});

describe('createEventBus over Redis Streams', () => {
  it('round-trips a known event from emit to a subscriber', async () => {
    const { bus, serviceName } = realBus();
    const received: unknown[] = [];
    bus.on('wallet.deposit.completed', (p) => {
      received.push(p);
    });
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('wallet.deposit.completed'),
      group: serviceName,
    });

    const payload = deposit();
    bus.emit('wallet.deposit.completed', payload);

    await vi.waitFor(() => expect(received).toEqual([payload]), DELIVERY);
  });

  it('delivers the envelope as the optional second arg to handlers', async () => {
    const { bus, serviceName } = realBus();
    const envelopes: Array<EventEnvelope | undefined> = [];
    bus.on('wallet.deposit.completed', (_payload, envelope) => {
      envelopes.push(envelope);
    });
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('wallet.deposit.completed'),
      group: serviceName,
    });

    bus.emit('wallet.deposit.completed', deposit());

    await vi.waitFor(() => expect(envelopes).toHaveLength(1), DELIVERY);
    const env = envelopes[0];
    expect(typeof env?.eventId).toBe('string');
    expect(env?.eventId).toHaveLength(36);
    expect(env?.topic).toBe('wallet.deposit.completed');
    expect(env?.schemaVersion).toBe(2);
    expect(typeof env?.occurredAt).toBe('string');
  });

  it('envelope eventId is unique per emission', async () => {
    const { bus, serviceName } = realBus();
    const ids: string[] = [];
    bus.on('wallet.deposit.completed', (_p, env) => {
      if (env?.eventId) {
        ids.push(env.eventId);
      }
    });
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('wallet.deposit.completed'),
      group: serviceName,
    });

    bus.emit('wallet.deposit.completed', deposit());
    bus.emit('wallet.deposit.completed', deposit());

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
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('identity.user.registered'),
      group: serviceName,
    });

    bus.emit('identity.user.registered', { userId: USER_ID, playerId: null });

    await vi.waitFor(() => expect(order.slice(0, 2)).toEqual(['first', 'second']), DELIVERY);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.user.registered' }),
      'event subscriber threw',
    );
  });

  it('throws on emit and emitInTransaction when a known payload fails its schema', async () => {
    const { bus } = realBus();

    expect(() => bus.emit('identity.user.registered', { userId: 123 } as never)).toThrow(
      /identity.user.registered/,
    );
    await expect(
      db.drizzle.db.transaction((tx) =>
        bus.emitInTransaction(tx, 'identity.user.registered', { userId: 123 } as never),
      ),
    ).rejects.toThrow(/identity.user.registered/);
    expect(await db.drizzle.db.select().from(eventOutbox)).toEqual([]);
  });

  it('dead-letters an inbound event whose payload fails its schema', async () => {
    const { bus, serviceName, broker } = realBus();
    const handler = vi.fn();
    bus.on('identity.user.registered', handler);
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('identity.user.registered'),
      group: serviceName,
    });

    await broker.publish(envelopeOf('identity.user.registered', { userId: 123 }));

    await vi.waitFor(
      async () => expect(await redis.client.xLen('oss:dlq:identity.user.registered')).toBe(1),
      DELIVERY,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs a consumer-keyed handler once for a duplicated delivery', async () => {
    const { bus, serviceName, broker } = realBus();
    const keyed = vi.fn();
    const unkeyed = vi.fn();
    bus.on('wallet.deposit.completed', keyed, { consumer: 'svc/wallet.deposit.completed' });
    bus.on('wallet.deposit.completed', unkeyed);
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('wallet.deposit.completed'),
      group: serviceName,
    });

    const envelope = envelopeOf('wallet.deposit.completed', deposit());
    await broker.publish(envelope);
    await broker.publish(envelope);

    await vi.waitFor(() => expect(unkeyed).toHaveBeenCalledTimes(2), DELIVERY);
    expect(keyed).toHaveBeenCalledTimes(1);
  });

  it('redelivers to the failed handler only, skipping the sibling that already succeeded', async () => {
    const { bus, serviceName } = realBus();
    let flakyCalls = 0;
    const steady = vi.fn();
    bus.on('wallet.deposit.completed', steady, { consumer: 'svc/steady' });
    bus.on(
      'wallet.deposit.completed',
      () => {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          throw new Error('transient');
        }
      },
      { consumer: 'svc/flaky' },
    );
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('wallet.deposit.completed'),
      group: serviceName,
    });

    bus.emit('wallet.deposit.completed', deposit());

    await vi.waitFor(() => expect(flakyCalls).toBe(2), DELIVERY);
    await vi.waitFor(async () => {
      const pending = await redis.client.xPending(
        streamOf('wallet.deposit.completed'),
        serviceName,
      );
      expect(pending.pending).toBe(0);
    }, DELIVERY);
    expect(steady).toHaveBeenCalledTimes(1);
  });

  it('publishes an emitInTransaction event only when its transaction commits', async () => {
    const { bus, serviceName, broker } = realBus();
    const received: unknown[] = [];
    bus.on('wallet.deposit.completed', (p) => {
      received.push(p);
    });
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('wallet.deposit.completed'),
      group: serviceName,
    });
    const relay = new OutboxRelay(db.drizzle.db, broker);

    await expect(
      db.drizzle.db.transaction(async (tx) => {
        await bus.emitInTransaction(tx, 'wallet.deposit.completed', deposit());
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await relay.drainOnce()).toBe(0);

    const committed = deposit();
    await db.drizzle.db.transaction((tx) =>
      bus.emitInTransaction(tx, 'wallet.deposit.completed', committed),
    );
    expect(await relay.drainOnce()).toBe(1);

    await vi.waitFor(() => expect(received).toEqual([committed]), DELIVERY);
  });

  it('applies schema defaults to a legacy backlog payload before the handler runs', async () => {
    const { bus, serviceName, broker } = realBus();
    const received: Array<Record<string, unknown>> = [];
    const envelopePayloads: unknown[] = [];
    bus.on('cms.banner.image.deleted', (payload, envelope) => {
      received.push(payload as Record<string, unknown>);
      envelopePayloads.push(envelope?.payload);
    });
    await waitForConsumerGroup(redis.client, {
      stream: streamOf('cms.banner.image.deleted'),
      group: serviceName,
    });

    const legacyPayload = {
      bannerImageId: randomUUID(),
      bannerConfigurationId: randomUUID(),
      actorId: randomUUID(),
    };
    await broker.publish({
      eventId: randomUUID(),
      topic: 'cms.banner.image.deleted',
      payload: legacyPayload,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    });

    await vi.waitFor(() => expect(received).toHaveLength(1), DELIVERY);
    expect(received[0]).toEqual({ ...legacyPayload, droppedImageUrls: [] });
    expect(envelopePayloads[0]).toEqual({ ...legacyPayload, droppedImageUrls: [] });
  });

  it('logs a rejected async publish instead of an unhandled rejection', async () => {
    const logger = fakeLogger();
    const rejectingBroker: MessageBrokerAdapter = {
      publish: () => Promise.reject(new Error('broker down')),
      subscribe: (_topic: string, _handler: BrokerHandler) => () => undefined,
      close: async () => undefined,
    };
    const bus = busOver(rejectingBroker, logger);

    bus.emit('gaming.round.ended', roundEnded());
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
    const bus = busOver(fakeBroker);

    const payload = roundEnded();
    bus.emit('gaming.round.ended', payload);

    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe('gaming.round.ended');
    expect(published[0]?.payload).toEqual(payload);
    expect(typeof published[0]?.eventId).toBe('string');
  });
});
