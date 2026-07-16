import { describe, it, expect, vi } from 'vitest';
import { ORPCError } from '@orpc/server';
import { assertRateLimit, makeRateLimitError } from '../rate-limiter.js';
import { InProcessRateLimiter } from '@openora/core/testing';

const OPTS = { limit: 3, windowMs: 1000 };

describe('assertRateLimit / makeRateLimitError', () => {
  it('throws a TOO_MANY_REQUESTS ORPCError carrying retryAfterMs once the limit is hit', async () => {
    vi.useFakeTimers();
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await assertRateLimit(limiter, 'k', OPTS);
    }
    await expect(assertRateLimit(limiter, 'k', OPTS)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      data: { retryAfterMs: OPTS.windowMs },
    });
    limiter.close();
    vi.useRealTimers();
  });

  it('does not throw while under the limit', async () => {
    const limiter = new InProcessRateLimiter();
    await expect(assertRateLimit(limiter, 'k', OPTS)).resolves.toBeUndefined();
    limiter.close();
  });

  it('makeRateLimitError builds a 429 error', () => {
    const err = makeRateLimitError(500);
    expect(err).toBeInstanceOf(ORPCError);
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(err.data).toEqual({ retryAfterMs: 500 });
  });
});
