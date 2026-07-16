import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ORPCError } from '@orpc/server';
import { assertRateLimit, makeRateLimitError } from '@openora/core/server';
import { InProcessRateLimiter } from '../rate-limiter.js';

const OPTS = { limit: 3, windowMs: 1000 };

describe('InProcessRateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows up to the limit then denies within the same window', async () => {
    const limiter = new InProcessRateLimiter();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await limiter.consume('k', OPTS));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    limiter.close();
  });

  it('reports retryAfterMs equal to the time left in the window on denial', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    vi.advanceTimersByTime(400);
    const denied = await limiter.consume('k', OPTS);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(600);
    limiter.close();
  });

  it('rolls over: a fresh budget is available once the window elapses', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('k', OPTS);
    }
    expect((await limiter.consume('k', OPTS)).allowed).toBe(false);
    vi.advanceTimersByTime(1000);
    expect((await limiter.consume('k', OPTS)).allowed).toBe(true);
    limiter.close();
  });

  it('isolates budgets between keys', async () => {
    const limiter = new InProcessRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.consume('a', OPTS);
    }
    expect((await limiter.consume('a', OPTS)).allowed).toBe(false);
    expect((await limiter.consume('b', OPTS)).allowed).toBe(true);
    limiter.close();
  });
});

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
