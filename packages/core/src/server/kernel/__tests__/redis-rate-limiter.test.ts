import { describe, it, expect, vi } from 'vitest';
import { RedisRateLimiter } from '../redis-rate-limiter.js';
import type { RedisClient } from '../redis-client.js';
import { mock } from '../../../testing/mock.js';

type EvalImpl = () => Promise<unknown>;

function fakeClient(opts: { isReady?: boolean; evalImpl?: EvalImpl }) {
  return {
    isReady: opts.isReady ?? true,
    eval: vi.fn(opts.evalImpl ?? (async () => [1, 1000])),
  };
}

const WINDOW = { limit: 10, windowMs: 5000 };

describe('RedisRateLimiter', () => {
  it('allows while under the limit and reports no back-off', async () => {
    const fake = fakeClient({ evalImpl: async () => [3, 4000] });
    const limiter = new RedisRateLimiter(mock<RedisClient>(fake));

    expect(await limiter.consume('login:a', WINDOW)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(fake.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ['rl:login:a'],
      arguments: ['5000'],
    });
  });

  it('denies once the count exceeds the limit, using PTTL as the back-off', async () => {
    const fake = fakeClient({ evalImpl: async () => [11, 4200] });
    const limiter = new RedisRateLimiter(mock<RedisClient>(fake));

    expect(await limiter.consume('login:a', WINDOW)).toEqual({
      allowed: false,
      retryAfterMs: 4200,
    });
  });

  it('fails open (allows) when the socket is not ready and the key does not opt into deny', async () => {
    const limiter = new RedisRateLimiter(mock<RedisClient>(fakeClient({ isReady: false })));
    expect(await limiter.consume('login:a', WINDOW)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('fails closed with windowMs when not ready and the key opts into deny', async () => {
    const limiter = new RedisRateLimiter(mock<RedisClient>(fakeClient({ isReady: false })));
    expect(await limiter.consume('login:a', { ...WINDOW, onUnavailable: 'deny' })).toEqual({
      allowed: false,
      retryAfterMs: 5000,
    });
  });

  it('applies the same fail-open/deny policy on a command error', async () => {
    const throwing: EvalImpl = async () => {
      throw new Error('redis down');
    };
    const openLimiter = new RedisRateLimiter(mock<RedisClient>(fakeClient({ evalImpl: throwing })));
    const denyLimiter = new RedisRateLimiter(mock<RedisClient>(fakeClient({ evalImpl: throwing })));

    expect(await openLimiter.consume('login:a', WINDOW)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    expect(await denyLimiter.consume('login:a', { ...WINDOW, onUnavailable: 'deny' })).toEqual({
      allowed: false,
      retryAfterMs: 5000,
    });
  });
});
