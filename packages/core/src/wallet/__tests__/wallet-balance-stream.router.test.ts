import { describe, it, expect } from 'vitest';
import { InProcessRealtimeTransport } from '@openora/core/testing';
import { createWalletBalanceStream, walletBalanceChannel } from '../router/index.js';

describe('wallet streamBalance router', () => {
  it('streams only the caller-scoped channel, never another player`s balance updates', async () => {
    const realtime = new InProcessRealtimeTransport();
    const iterator = createWalletBalanceStream(realtime, 'user-1', undefined)[
      Symbol.asyncIterator
    ]();
    const next = iterator.next();
    await Promise.resolve();

    realtime.publish(walletBalanceChannel('other-user'), {
      eventId: '11111111-1111-4111-8111-111111111111',
      currency: 'USD',
      reason: 'deposit',
    });
    realtime.publish(walletBalanceChannel('user-1'), {
      eventId: '22222222-2222-4222-8222-222222222222',
      currency: 'USD',
      reason: 'withdrawal',
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        eventId: '22222222-2222-4222-8222-222222222222',
        currency: 'USD',
        reason: 'withdrawal',
      },
    });
    await iterator.return?.(undefined);
  });
});
