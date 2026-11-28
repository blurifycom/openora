import type { CacheAdapter } from '@openora/core/contracts';
import type { RedisClient } from './redis-client.js';

const PREFIX = 'cache:';

export class RedisCache implements CacheAdapter {
  constructor(private readonly client: RedisClient) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.client.isReady) {
      return undefined;
    }
    const raw = await this.client.get(PREFIX + key);
    if (raw === null) {
      return undefined;
    }
    return JSON.parse(raw);
  }

  async set<T>(key: string, value: T, opts: { ttlMs: number }): Promise<void> {
    if (!this.client.isReady) {
      return;
    }
    await this.client.set(PREFIX + key, JSON.stringify(value), {
      expiration: { type: 'PX', value: opts.ttlMs },
    });
  }

  async setIfAbsent<T>(key: string, value: T, opts: { ttlMs: number }): Promise<boolean> {
    if (!this.client.isReady) {
      throw new Error('Redis is not ready');
    }
    const result = await this.client.set(PREFIX + key, JSON.stringify(value), {
      expiration: { type: 'PX', value: opts.ttlMs },
      condition: 'NX',
    });
    return result === 'OK';
  }

  async delete(key: string | string[]): Promise<void> {
    if (!this.client.isReady) {
      return;
    }
    const keys = (Array.isArray(key) ? key : [key]).map((k) => PREFIX + k);
    if (keys.length === 0) {
      return;
    }
    await this.client.del(keys);
  }
}
