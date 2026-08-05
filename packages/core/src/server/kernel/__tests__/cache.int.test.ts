import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { CacheAdapter } from '@openora/core/contracts';
import { cached, invalidate } from '../cache.js';
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

describe('cached', () => {
  it('loads and stores on a miss', async () => {
    const loader = vi.fn().mockResolvedValue('loaded');

    expect(await cached(cache, 'k', 5000, loader)).toBe('loaded');
    expect(loader).toHaveBeenCalledOnce();
    expect(await cache.get('k')).toBe('loaded');
  });

  it('serves the cached value on a hit without calling the loader again', async () => {
    const loader = vi.fn().mockResolvedValue('loaded');

    await cached(cache, 'k', 5000, loader);
    const result = await cached(cache, 'k', 5000, loader);

    expect(result).toBe('loaded');
    expect(loader).toHaveBeenCalledOnce();
  });
});

describe('invalidate', () => {
  it('removes the cached key so the next load re-runs', async () => {
    const loader = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');

    expect(await cached(cache, 'k', 5000, loader)).toBe('v1');
    await invalidate(cache, 'k');
    expect(await cached(cache, 'k', 5000, loader)).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('swallows a delete failure instead of throwing', async () => {
    const failing: CacheAdapter = {
      get: async () => undefined,
      set: async () => {},
      setIfAbsent: async () => false,
      delete: async () => {
        throw new Error('backend down');
      },
    };
    await expect(invalidate(failing, 'k')).resolves.toBeUndefined();
  });
});
