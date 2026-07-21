import { describe, it, expect, vi } from 'vitest';
import { InProcessCache } from '../cache.js';

describe('InProcessCache', () => {
  it('returns undefined for a key never set', async () => {
    const cache = new InProcessCache();
    await expect(cache.get('missing')).resolves.toBeUndefined();
    cache.close();
  });

  it('round-trips a value within its TTL', async () => {
    vi.useFakeTimers();
    const cache = new InProcessCache();
    await cache.set('k', { a: 1 }, { ttlMs: 1000 });
    vi.advanceTimersByTime(999);
    await expect(cache.get('k')).resolves.toEqual({ a: 1 });
    cache.close();
    vi.useRealTimers();
  });

  it('expires a value once its TTL elapses', async () => {
    vi.useFakeTimers();
    const cache = new InProcessCache();
    await cache.set('k', 'v', { ttlMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(cache.get('k')).resolves.toBeUndefined();
    cache.close();
    vi.useRealTimers();
  });

  it('set on an existing key refreshes its expiry', async () => {
    vi.useFakeTimers();
    const cache = new InProcessCache();
    await cache.set('k', 'first', { ttlMs: 1000 });
    vi.advanceTimersByTime(800);
    await cache.set('k', 'second', { ttlMs: 1000 });
    vi.advanceTimersByTime(800);
    await expect(cache.get('k')).resolves.toBe('second');
    cache.close();
    vi.useRealTimers();
  });

  it('deletes a single key and an array of keys', async () => {
    const cache = new InProcessCache();
    await cache.set('a', 1, { ttlMs: 1000 });
    await cache.set('b', 2, { ttlMs: 1000 });
    await cache.set('c', 3, { ttlMs: 1000 });
    await cache.delete('a');
    await cache.delete(['b', 'c']);
    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('b')).resolves.toBeUndefined();
    await expect(cache.get('c')).resolves.toBeUndefined();
    cache.close();
  });

  it('evicts the oldest-inserted entry once MAX_ENTRIES is reached', async () => {
    const cache = new InProcessCache();
    for (let i = 0; i < 5_000; i++) {
      await cache.set(`k${i}`, i, { ttlMs: 60_000 });
    }
    await cache.set('overflow', 'v', { ttlMs: 60_000 });
    // k0 was inserted first, so it is the one evicted - k1 and the newcomer survive.
    await expect(cache.get('k0')).resolves.toBeUndefined();
    await expect(cache.get('k1')).resolves.toBe(1);
    await expect(cache.get('overflow')).resolves.toBe('v');
    cache.close();
  });

  it('overwriting an existing key at capacity evicts nothing', async () => {
    const cache = new InProcessCache();
    for (let i = 0; i < 5_000; i++) {
      await cache.set(`k${i}`, i, { ttlMs: 60_000 });
    }
    await cache.set('k0', 'updated', { ttlMs: 60_000 });
    await expect(cache.get('k0')).resolves.toBe('updated');
    await expect(cache.get('k1')).resolves.toBe(1);
    cache.close();
  });

  it('the sweep drops expired entries that are never read again', async () => {
    vi.useFakeTimers();
    const cache = new InProcessCache();
    await cache.set('k', 'v', { ttlMs: 1000 });
    // Past the entry's TTL and the 60s sweep interval, without ever calling get().
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(cache.get('k')).resolves.toBeUndefined();
    cache.close();
    vi.useRealTimers();
  });

  it('close clears every entry', async () => {
    const cache = new InProcessCache();
    await cache.set('k', 'v', { ttlMs: 60_000 });
    cache.close();
    await expect(cache.get('k')).resolves.toBeUndefined();
  });
});
