import { describe, it, expect, vi } from 'vitest';
import type { CacheAdapter } from '@openora/core/contracts';
import { cached, invalidate } from '../cache.js';
import { InProcessCache } from '@openora/core/testing';

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
    const failing: CacheAdapter = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {
        throw new Error('backend down');
      },
    };
    await expect(invalidate(failing, 'k')).resolves.toBeUndefined();
  });
});
