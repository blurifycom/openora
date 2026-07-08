import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InProcessCache, cached, invalidate } from '../cache.js';
import type { CacheAdapter } from '@blurifycom/core/contracts';
import { mock } from '../../../testing/mock.js';

describe('InProcessCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns undefined for a missing key', async () => {
    const cache = new InProcessCache();
    expect(await cache.get('missing')).toBeUndefined();
    cache.close();
  });

  it('returns the stored value before the ttl elapses', async () => {
    const cache = new InProcessCache();
    await cache.set('k', 'v', { ttlMs: 1000 });
    vi.advanceTimersByTime(500);
    expect(await cache.get('k')).toBe('v');
    cache.close();
  });

  it('expires lazily once the ttl elapses', async () => {
    const cache = new InProcessCache();
    await cache.set('k', 'v', { ttlMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(await cache.get('k')).toBeUndefined();
    cache.close();
  });

  it('deletes a single key', async () => {
    const cache = new InProcessCache();
    await cache.set('a', 1, { ttlMs: 1000 });
    await cache.delete('a');
    expect(await cache.get('a')).toBeUndefined();
    cache.close();
  });

  it('deletes an array of keys', async () => {
    const cache = new InProcessCache();
    await cache.set('a', 1, { ttlMs: 1000 });
    await cache.set('b', 2, { ttlMs: 1000 });
    await cache.delete(['a', 'b']);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBeUndefined();
    cache.close();
  });

  it('evicts the oldest entry once the max-entries cap is hit', async () => {
    const cache = new InProcessCache();
    for (let i = 0; i < 5_000; i++) {
      await cache.set(`k${i}`, i, { ttlMs: 60_000 });
    }
    expect(await cache.get('k0')).toBe(0);
    await cache.set('k5000', 5000, { ttlMs: 60_000 });
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get('k5000')).toBe(5000);
    cache.close();
  });
});

describe('cached', () => {
  it('loads and stores on a miss', async () => {
    const cache = new InProcessCache();
    const loader = vi.fn().mockResolvedValue('loaded');
    const result = await cached(cache, 'k', 1000, loader);
    expect(result).toBe('loaded');
    expect(loader).toHaveBeenCalledOnce();
    cache.close();
  });

  it('serves the cached value on a hit without calling the loader again', async () => {
    vi.useFakeTimers();
    const cache = new InProcessCache();
    const loader = vi.fn().mockResolvedValue('loaded');
    await cached(cache, 'k', 1000, loader);
    vi.advanceTimersByTime(500);
    const result = await cached(cache, 'k', 1000, loader);
    expect(result).toBe('loaded');
    expect(loader).toHaveBeenCalledOnce();
    cache.close();
    vi.useRealTimers();
  });
});

describe('invalidate', () => {
  it('swallows a delete failure instead of throwing', async () => {
    const cache = mock<CacheAdapter>({
      delete: vi.fn().mockRejectedValue(new Error('backend down')),
    });

    await expect(invalidate(cache, 'k')).resolves.toBeUndefined();
  });
});
