import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { MessageBrokerAdapter, BrokerHandler } from '@oss/adapters';
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

    expect(received).toEqual([
      { userId: 'u1', amount: 50, currency: 'USD', transactionId: 'tx1' },
    ]);
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
    const published: Array<{ topic: string; payload: unknown }> = [];
    const fakeBroker: MessageBrokerAdapter = {
      publish: (topic, payload) => {
        published.push({ topic, payload });
      },
      subscribe: (_topic: string, _handler: BrokerHandler) => {},
    };
    const bus = createEventBus(fakeBroker, fakeLogger());

    bus.emit('gaming.round.ended', { roundId: 'r1', userId: 'u1' });

    expect(published).toEqual([
      { topic: 'gaming.round.ended', payload: { roundId: 'r1', userId: 'u1' } },
    ]);
  });
});
