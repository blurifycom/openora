import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestRedis,
  RedisPubSubRealtimeTransport,
  type TestRedis,
} from '@openora/core/testing';
import { createWalletBalanceStream, walletBalanceChannel } from '../router/index.js';

let redis: TestRedis;

const SUBSCRIBE_SETTLE_MS = 200;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis.quit();
});

describe('wallet streamBalance router', () => {
  it('streams only the caller-scoped channel, never another player`s balance updates', async () => {
    const realtime = new RedisPubSubRealtimeTransport(redis.client, 'wallet-balance-stream-test');
    try {
      const iterator = createWalletBalanceStream(realtime, 'user-1', undefined)[
        Symbol.asyncIterator
      ]();
      const next = iterator.next();
      await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));

      await realtime.publish(walletBalanceChannel('other-user'), {
        eventId: '11111111-1111-4111-8111-111111111111',
        currency: 'USD',
        reason: 'deposit',
      });
      const callerUpdate = {
        eventId: '22222222-2222-4222-8222-222222222222',
        currency: 'USD',
        reason: 'withdrawal',
      };
      await realtime.publish(walletBalanceChannel('user-1'), callerUpdate);

      await expect(next).resolves.toEqual({ done: false, value: callerUpdate });
      await iterator.return?.(undefined);
    } finally {
      await realtime.close();
    }
  });
});
