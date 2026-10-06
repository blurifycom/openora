import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { createTestRedis, type TestRedis } from '@openora/core/testing';
import { RedisRateLimiter } from '../../kernel/redis-rate-limiter.js';
import { consumeTokenRateLimit, type TokenRateLimitVerdict } from '../transport-gate.js';

const DAY_SECONDS = 86_400;

let redis: TestRedis;

function retryAfterOf(verdict: TokenRateLimitVerdict) {
  if (verdict.allowed) {
    throw new Error('expected the limiter to refuse');
  }
  return verdict.retryAfterSeconds;
}

function offlineLimiter() {
  const client = createClient({ url: 'redis://127.0.0.1:1' });
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

describe('consumeTokenRateLimit on the Redis limiter', () => {
  it('allows the minute limit, then refuses until the minute window resets', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const tokenId = randomUUID();
    const limits = { perMinute: 3, perDay: 100 };

    const allowed = [];
    for (let call = 0; call < limits.perMinute; call += 1) {
      allowed.push(await consumeTokenRateLimit(limiter, tokenId, limits));
    }
    const refused = await consumeTokenRateLimit(limiter, tokenId, limits);

    expect(allowed).toEqual([{ allowed: true }, { allowed: true }, { allowed: true }]);
    expect(retryAfterOf(refused)).toBeGreaterThanOrEqual(1);
    expect(retryAfterOf(refused)).toBeLessThanOrEqual(60);
  });

  it('caps the day: a two-a-day token waits about a day for its third call', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const tokenId = randomUUID();
    const limits = { perMinute: 100, perDay: 2 };

    await consumeTokenRateLimit(limiter, tokenId, limits);
    await consumeTokenRateLimit(limiter, tokenId, limits);
    const third = await consumeTokenRateLimit(limiter, tokenId, limits);

    expect(retryAfterOf(third)).toBeGreaterThan(DAY_SECONDS - 60);
    expect(retryAfterOf(third)).toBeLessThanOrEqual(DAY_SECONDS);
  });

  it('does not count a request the minute window refused against the day', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const tokenId = randomUUID();
    const limits = { perMinute: 1, perDay: 5 };

    await consumeTokenRateLimit(limiter, tokenId, limits);
    await consumeTokenRateLimit(limiter, tokenId, limits);
    await consumeTokenRateLimit(limiter, tokenId, limits);

    expect(await redis.client.get(`rl:mcp-token-min:${tokenId}`)).toBe('3');
    expect(await redis.client.get(`rl:mcp-token-day:${tokenId}`)).toBe('1');
  });

  it('keeps every token on its own counters', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const limits = { perMinute: 1, perDay: 10 };
    const exhausted = randomUUID();

    await consumeTokenRateLimit(limiter, exhausted, limits);

    expect((await consumeTokenRateLimit(limiter, exhausted, limits)).allowed).toBe(false);
    expect(await consumeTokenRateLimit(limiter, randomUUID(), limits)).toEqual({ allowed: true });
  });

  it('refuses while the limiter is unreachable', async () => {
    expect(
      await consumeTokenRateLimit(offlineLimiter(), randomUUID(), { perMinute: 60, perDay: 2000 }),
    ).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});
