import type { CacheAdapter } from '@blurifycom/core/contracts';
import type { RedisClient } from './redis-client.js';

const PREFIX = 'cache:';

// Distributed reference cache, bound when REDIS_URL is set. Values are JSON so any
// serializable shape round-trips. The `isReady` guards fast-path a miss/no-op when
// the socket is reconnecting so a request never blocks on Redis; command errors are
// NOT swallowed here - the cached()/invalidate() helpers already try/catch so a
// cache fault degrades to a load, never a failed request.
export class RedisCache implements CacheAdapter {
  constructor(private readonly client: RedisClient) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.client.isReady) return undefined;
    const raw = await this.client.get(PREFIX + key);
    if (raw === null) return undefined;
    return JSON.parse(raw);
  }

  async set<T>(key: string, value: T, opts: { ttlMs: number }): Promise<void> {
    if (!this.client.isReady) return;
    await this.client.set(PREFIX + key, JSON.stringify(value), {
      expiration: { type: 'PX', value: opts.ttlMs },
    });
  }

  async delete(key: string | string[]): Promise<void> {
    if (!this.client.isReady) return;
    const keys = (Array.isArray(key) ? key : [key]).map((k) => PREFIX + k);
    if (keys.length === 0) return;
    await this.client.del(keys);
  }
}
