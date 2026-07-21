import type { CacheAdapter } from '@openora/core/contracts';
import { createLogger } from './logger.js';

const logger = createLogger('cache');

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
