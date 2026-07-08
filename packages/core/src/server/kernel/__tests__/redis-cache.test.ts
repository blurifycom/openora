import { describe, it, expect, vi } from 'vitest';
import { RedisCache } from '../redis-cache.js';
import type { RedisClient } from '../redis-client.js';
import { mock } from '../../../testing/mock.js';

function fakeClient(isReady = true) {
  const store = new Map<string, string>();
  const set = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const del = vi.fn(async (keys: string[]) => {
    for (const k of keys) store.delete(k);
    return keys.length;
  });
  return { isReady, get, set, del };
}

describe('RedisCache', () => {
  it('round-trips a JSON value under the cache: prefix and passes a PX ttl', async () => {
    const fake = fakeClient();
    const cache = new RedisCache(mock<RedisClient>(fake));

    await cache.set('lobby', { games: [1, 2] }, { ttlMs: 1000 });

    expect(fake.set).toHaveBeenCalledWith('cache:lobby', JSON.stringify({ games: [1, 2] }), {
      expiration: { type: 'PX', value: 1000 },
    });
    expect(await cache.get('lobby')).toEqual({ games: [1, 2] });
  });

  it('returns undefined on a miss', async () => {
    const cache = new RedisCache(mock<RedisClient>(fakeClient()));
    expect(await cache.get('absent')).toBeUndefined();
  });

  it('deletes multiple keys in a single DEL call, all prefixed', async () => {
    const fake = fakeClient();
    const cache = new RedisCache(mock<RedisClient>(fake));

    await cache.delete(['a', 'b', 'c']);

    expect(fake.del).toHaveBeenCalledTimes(1);
    expect(fake.del).toHaveBeenCalledWith(['cache:a', 'cache:b', 'cache:c']);
  });

  it('fast-paths a miss and a no-op write while the socket is not ready', async () => {
    const fake = fakeClient(false);
    const cache = new RedisCache(mock<RedisClient>(fake));

    expect(await cache.get('lobby')).toBeUndefined();
    await cache.set('lobby', { games: [1] }, { ttlMs: 1000 });

    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.set).not.toHaveBeenCalled();
  });
});
