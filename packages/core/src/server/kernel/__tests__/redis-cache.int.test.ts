import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient } from 'redis';
import { RedisCache } from '../redis-cache.js';
import { createTestRedis, type TestRedis } from '@openora/core/testing';

let redis: TestRedis;
let cache: RedisCache;

beforeAll(async () => {
  redis = await createTestRedis();
  cache = new RedisCache(redis.client);
});

afterAll(async () => {
  await redis.quit();
});

beforeEach(async () => {
  await redis.flush();
});

describe('RedisCache', () => {
  it('round-trips a JSON value under the cache: prefix with a PX ttl', async () => {
    await cache.set('lobby', { games: [1, 2] }, { ttlMs: 1000 });

    expect(await cache.get('lobby')).toEqual({ games: [1, 2] });
    expect(await redis.client.get('cache:lobby')).toBe(JSON.stringify({ games: [1, 2] }));

    const pttl = await redis.client.pTTL('cache:lobby');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(1000);
  });

  it('returns undefined on a miss', async () => {
    expect(await cache.get('absent')).toBeUndefined();
  });

  it('deletes every given key, all under the prefix', async () => {
    await cache.set('a', 1, { ttlMs: 5000 });
    await cache.set('b', 2, { ttlMs: 5000 });
    await cache.set('c', 3, { ttlMs: 5000 });

    await cache.delete(['a', 'b', 'c']);

    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBeUndefined();
    expect(await redis.client.exists(['cache:a', 'cache:b', 'cache:c'])).toBe(0);
  });

  it('fast-paths a miss and a no-op write while the socket is not ready', async () => {
    const offline = createClient({ url: 'redis://localhost:6379' });
    offline.on('error', () => undefined);
    const offlineCache = new RedisCache(offline);

    expect(await offlineCache.get('lobby')).toBeUndefined();
    await offlineCache.set('lobby', { games: [1] }, { ttlMs: 1000 });

    // The client never connected, so nothing was written anywhere.
    expect(await cache.get('lobby')).toBeUndefined();
  });
});
