import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { createTestRedis, type TestRedis } from '@openora/core/testing';
import { RedisRateLimiter } from '../../kernel/redis-rate-limiter.js';
import {
  consumeAddressRateLimit,
  consumeTokenRateLimit,
  type RateLimitVerdict,
} from '../transport-gate.js';

const DAY_SECONDS = 86_400;
const CLIENT_IP = '203.0.113.7';
const OTHER_CLIENT_IP = '2001:db8::7';

let redis: TestRedis;

function retryAfterOf(verdict: RateLimitVerdict) {
  if (verdict.status !== 'limited') {
    throw new Error(`expected a spent window, got ${verdict.status}`);
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

    expect(allowed).toEqual([{ status: 'allowed' }, { status: 'allowed' }, { status: 'allowed' }]);
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

    expect((await consumeTokenRateLimit(limiter, exhausted, limits)).status).toBe('limited');
    expect(await consumeTokenRateLimit(limiter, randomUUID(), limits)).toEqual({
      status: 'allowed',
    });
  });

  it('reports the limiter as unavailable while it is unreachable', async () => {
    expect(
      await consumeTokenRateLimit(offlineLimiter(), randomUUID(), { perMinute: 60, perDay: 2000 }),
    ).toEqual({ status: 'unavailable' });
  });
});

describe('consumeAddressRateLimit on the Redis limiter', () => {
  it('allows the per-address limit, then refuses until the minute window resets', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const perIpPerMinute = 2;

    await consumeAddressRateLimit(limiter, CLIENT_IP, perIpPerMinute);
    await consumeAddressRateLimit(limiter, CLIENT_IP, perIpPerMinute);
    const refused = await consumeAddressRateLimit(limiter, CLIENT_IP, perIpPerMinute);

    expect(retryAfterOf(refused)).toBeGreaterThanOrEqual(1);
    expect(retryAfterOf(refused)).toBeLessThanOrEqual(60);
    expect(await redis.client.get(`rl:mcp-ip-min:${CLIENT_IP}`)).toBe('3');
  });

  it('keeps every address, an IPv6 one included, on its own counter', async () => {
    const limiter = new RedisRateLimiter(redis.client);

    await consumeAddressRateLimit(limiter, CLIENT_IP, 1);

    expect((await consumeAddressRateLimit(limiter, CLIENT_IP, 1)).status).toBe('limited');
    expect(await consumeAddressRateLimit(limiter, OTHER_CLIENT_IP, 1)).toEqual({
      status: 'allowed',
    });
    expect(await redis.client.get(`rl:mcp-ip-min:${OTHER_CLIENT_IP}`)).toBe('1');
  });

  it('reports the limiter as unavailable while it is unreachable', async () => {
    expect(await consumeAddressRateLimit(offlineLimiter(), CLIENT_IP, 300)).toEqual({
      status: 'unavailable',
    });
  });
});
