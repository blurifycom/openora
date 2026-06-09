import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { MessageBrokerAdapter, BrokerHandler, EventEnvelope } from '@oss/adapters';
import { createEventBus, InMemoryBroker } from '../event-bus.js';

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createEventBus', () => {
  it('round-trips a known event from emit to a subscriber', async () => {
    const bus = createEventBus(new InMemoryBroker(), fakeLogger());
    const received: unknown[] = [];
    bus.on('wallet.deposit.completed', (p) => {
      received.push(p);
    });

    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: 50,
      currency: 'USD',
      transactionId: 'tx1',
    });
    await flush();

    expect(received).toEqual([{ userId: 'u1', amount: 50, currency: 'USD', transactionId: 'tx1' }]);
  });

  it('delivers the envelope as the optional second arg to handlers', async () => {
    const bus = createEventBus(new InMemoryBroker(), fakeLogger());
    const envelopes: Array<EventEnvelope | undefined> = [];

    bus.on('wallet.deposit.completed', (_payload, envelope) => {
      envelopes.push(envelope);
    });
    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: 10,
      currency: 'USD',
      transactionId: 'tx2',
    });
    await flush();

    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    expect(typeof env?.eventId).toBe('string');
    expect(env?.eventId).toHaveLength(36); // UUID
    expect(env?.topic).toBe('wallet.deposit.completed');
    expect(env?.schemaVersion).toBe(1);
    expect(typeof env?.occurredAt).toBe('string');
  });

  it('envelope eventId is unique per emission', async () => {
    const bus = createEventBus(new InMemoryBroker(), fakeLogger());
    const ids: string[] = [];
    bus.on('wallet.deposit.completed', (_p, env) => {
      if (env?.eventId) ids.push(env.eventId);
    });

    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: 1,
      currency: 'USD',
      transactionId: 'a',
    });
    bus.emit('wallet.deposit.completed', {
      userId: 'u1',
      amount: 2,
      currency: 'USD',
      transactionId: 'b',
    });
    await flush();

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('isolates a throwing subscriber so siblings still run, and logs the failure', async () => {
    const logger = fakeLogger();
    const bus = createEventBus(new InMemoryBroker(), logger);
    const order: string[] = [];

    bus.on('identity.user.registered', () => {
      order.push('first');
      throw new Error('boom');
    });
    bus.on('identity.user.registered', () => {
      order.push('second');
    });

    bus.emit('identity.user.registered', { userId: 'u1' });
    await flush();

    expect(order).toEqual(['first', 'second']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.user.registered' }),
      'event subscriber threw',
    );
  });

  it('logs a validation error for a bad payload but still delivers', async () => {
    const logger = fakeLogger();
    const bus = createEventBus(new InMemoryBroker(), logger);
    const received: unknown[] = [];
    bus.on('identity.user.registered', (p) => {
      received.push(p);
    });

    // userId should be a string - send a number to trip validation.
    bus.emit('identity.user.registered', { userId: 123 } as never);
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'identity.user.registered' }),
      'event payload failed validation',
    );
    expect(received).toHaveLength(1); // delivered despite the validation warning
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
