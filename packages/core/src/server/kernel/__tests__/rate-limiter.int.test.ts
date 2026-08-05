import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ORPCError } from '@orpc/server';
import { assertRateLimit, makeRateLimitError } from '../rate-limiter.js';
import { RedisRateLimiter } from '../redis-rate-limiter.js';
import { createTestRedis, type TestRedis } from '@openora/core/testing';

const OPTS = { limit: 3, windowMs: 1000 };

let redis: TestRedis;
let limiter: RedisRateLimiter;

beforeAll(async () => {
  redis = await createTestRedis();
  limiter = new RedisRateLimiter(redis.client);
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flush();
});

describe('assertRateLimit / makeRateLimitError', () => {
  it('throws a TOO_MANY_REQUESTS ORPCError carrying retryAfterMs once the limit is hit', async () => {
    for (let i = 0; i < OPTS.limit; i++) {
      await assertRateLimit(limiter, 'k', OPTS);
    }

    const err = await assertRateLimit(limiter, 'k', OPTS).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ORPCError);
    expect((err as ORPCError<string, { retryAfterMs: number }>).code).toBe('TOO_MANY_REQUESTS');
    const retryAfterMs = (err as ORPCError<string, { retryAfterMs: number }>).data.retryAfterMs;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(OPTS.windowMs);
  });

  it('does not throw while under the limit', async () => {
    await expect(assertRateLimit(limiter, 'k', OPTS)).resolves.toBeUndefined();
  });

  it('makeRateLimitError builds a 429 error', () => {
    const err = makeRateLimitError(500);
    expect(err).toBeInstanceOf(ORPCError);
    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect(err.data).toEqual({ retryAfterMs: 500 });
  });
});
