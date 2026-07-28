import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient } from 'redis';
import { RedisRateLimiter } from '../redis-rate-limiter.js';
import { createTestRedis, type TestRedis } from '@openora/core/testing';

const WINDOW = { limit: 3, windowMs: 5000 };

let redis: TestRedis;

function offlineLimiter(): RedisRateLimiter {
  const client = createClient({ url: 'redis://localhost:6379' });
  client.on('error', () => undefined);
  return new RedisRateLimiter(client);
}

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flush();
});

describe('RedisRateLimiter', () => {
  it('allows up to the limit then denies, reporting a bounded back-off', async () => {
    const limiter = new RedisRateLimiter(redis.client);

    for (let i = 0; i < WINDOW.limit; i++) {
      expect(await limiter.consume('login:a', WINDOW)).toEqual({ allowed: true, retryAfterMs: 0 });
    }

    const blocked = await limiter.consume('login:a', WINDOW);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(WINDOW.windowMs);
  });

  it('sets the window expiry only on the first hit (subsequent hits reuse the TTL)', async () => {
    const limiter = new RedisRateLimiter(redis.client);

    await limiter.consume('login:a', WINDOW);
    const firstTtl = await redis.client.pTTL('rl:login:a');
    expect(firstTtl).toBeGreaterThan(0);
    expect(firstTtl).toBeLessThanOrEqual(WINDOW.windowMs);

    await limiter.consume('login:a', WINDOW);
    const secondTtl = await redis.client.pTTL('rl:login:a');
    // Second hit must NOT re-arm the window - the TTL only counts down.
    expect(secondTtl).toBeLessThanOrEqual(firstTtl);
  });

  it('counts each key independently', async () => {
    const limiter = new RedisRateLimiter(redis.client);

    for (let i = 0; i < WINDOW.limit; i++) {
      await limiter.consume('login:a', WINDOW);
    }

    expect((await limiter.consume('login:a', WINDOW)).allowed).toBe(false);
    expect((await limiter.consume('login:b', WINDOW)).allowed).toBe(true);
  });

  it('fails open when the socket is not ready and the key does not opt into deny', async () => {
    expect(await offlineLimiter().consume('login:a', WINDOW)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
  });

  it('fails closed with windowMs when not ready and the key opts into deny', async () => {
    expect(await offlineLimiter().consume('login:a', { ...WINDOW, onUnavailable: 'deny' })).toEqual(
      { allowed: false, retryAfterMs: WINDOW.windowMs },
    );
  });
});
