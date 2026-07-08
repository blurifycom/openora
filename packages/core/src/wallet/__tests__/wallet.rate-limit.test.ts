import { describe, it, expect, vi } from 'vitest';
import { InProcessRateLimiter, type EventBus } from '@openora/core/server';
import type { PaymentAdapter, AuditWritePort } from '@openora/core/contracts';
import { mock, mockDb } from '../../testing/mock.js';
import { WalletService } from '../service/wallet.service.js';

const drizzle = mockDb({});
const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
const payment = mock<PaymentAdapter>({});
const audit = mock<AuditWritePort>({ record: vi.fn() });

describe('WalletService - rate limiting', () => {
  it('rejects deposit with a 429 once the per-user mutation limit is exhausted', async () => {
    const userId = 'u1';
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 30; i++) {
      await limiter.consume(`wallet-mutation:${userId}`, { limit: 30, windowMs: 60_000 });
    }
    const svc = new WalletService({ drizzle, events, payment, limiter, audit });

    await expect(svc.deposit({ userId, amount: 100, currency: 'USD' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: expect.any(Number) },
    });
    limiter.close();
  });

  it('lets a withdraw through when the per-user budget is unused', async () => {
    const limiter = new InProcessRateLimiter();
    const svc = new WalletService({ drizzle, events, payment, limiter, audit });
    // No limiter denial: the call proceeds past the guard and fails later on the unused
    // drizzle double - so a non-429 rejection proves the guard let it through.
    await expect(
      svc.withdraw({ userId: 'u2', amount: 100, currency: 'USD' }),
    ).rejects.not.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    limiter.close();
  });
});
