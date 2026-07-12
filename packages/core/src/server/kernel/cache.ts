import type { CacheAdapter } from '@openora/core/contracts';
import { createLogger } from './logger.js';

const logger = createLogger('cache');

type Entry = { value: unknown; expiresAt: number };

const SWEEP_INTERVAL_MS = 60_000;
// ponytail: hard cap bounds memory against unbounded key growth (eg per-slug churn);
// eviction is oldest-insert (Map iteration order), not LRU - swap for an LRU if
// hit-rate under heavy key churn ever matters.
const MAX_ENTRIES = 5_000;

// Zero-dependency in-process default (set REDIS_URL to bind the distributed Redis
// reference adapter instead). Expiry is lazy (checked on access) plus an unref'd
// sweep so keys never revisited don't accumulate.
export class InProcessCache implements CacheAdapter {
  private readonly entries = new Map<string, Entry>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, opts: { ttlMs: number }): Promise<void> {
    if (!this.entries.has(key) && this.entries.size >= MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + opts.ttlMs });
    return Promise.resolve();
  }

  delete(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) {
      this.entries.delete(k);
    }
    return Promise.resolve();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    this.entries.clear();
  }
}

// ponytail: no single-flight guard - concurrent misses on the same key each run
// `loader`, so a hot key can stampede on cache-miss. Acceptable for the TTLs this
// is bound at (seconds); add a per-key in-flight promise map if that ever changes.
export async function cached<T>(
  cache: CacheAdapter | undefined,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!cache) {
    return loader();
  }

  let hit: T | undefined;
  try {
    hit = await cache.get<T>(key);
  } catch (err) {
    logger.warn({ key, err }, 'cache get failed');
    hit = undefined;
  }
  if (hit !== undefined) {
    return hit;
  }

  const value = await loader();
  try {
    await cache.set(key, value, { ttlMs });
  } catch (err) {
    logger.warn({ key, err }, 'cache set failed');
  }
  return value;
}

export async function invalidate(
  cache: CacheAdapter | undefined,
  keys: string | string[],
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.delete(keys);
  } catch (err) {
    logger.warn({ keys, err }, 'cache invalidate failed');
  }
}
