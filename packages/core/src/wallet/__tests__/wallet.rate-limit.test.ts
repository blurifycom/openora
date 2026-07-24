import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { EventBus } from '@openora/core/server';
import { RedisRateLimiter } from '@openora/core/server';
import { createTestRedis, type TestRedis } from '@openora/core/testing';
import type { PaymentAdapter, AuditWritePort } from '@openora/core/contracts';
import { mock, mockDb, NO_CLIENT_META } from '../../testing/mock.js';
import { WalletService } from '../service/wallet.service.js';

const drizzle = mockDb({});
const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
const payment = mock<PaymentAdapter>({});
const audit = mock<AuditWritePort>({ record: vi.fn() });

let redis: TestRedis;
const makeLimiter = () => new RedisRateLimiter(redis.client);

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flush();
});

describe('WalletService - rate limiting (real Redis)', () => {
  it('rejects deposit with a 429 once the per-user mutation limit is exhausted', async () => {
    const userId = 'u1';
    const limiter = makeLimiter();
    for (let i = 0; i < 30; i++) {
      await limiter.consume(`wallet-mutation:${userId}`, { limit: 30, windowMs: 60_000 });
    }
    const svc = new WalletService({ drizzle, events, payment, limiter, audit });

    await expect(svc.deposit({ userId, amount: '100', currency: 'USD' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: expect.any(Number) },
    });
  });

  it('lets a withdraw through when the per-user budget is unused', async () => {
    const limiter = makeLimiter();
    const svc = new WalletService({ drizzle, events, payment, limiter, audit });
    // No limiter denial: the call proceeds past the guard and fails later on the unused
    // drizzle double - so a non-429 rejection proves the guard let it through.
    await expect(
      svc.withdraw({ userId: 'u2', amount: '100', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.not.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});
