import { randomUUID } from 'node:crypto';
import type { CacheAdapter } from '@openora/core/contracts';
import { cached, invalidate } from '@openora/core/server';

const CATALOG_CACHE_TTL_MS = 30_000;
const CATALOG_EPOCH_KEY = 'gaming:catalog:epoch';

/**
 * Public catalog reads, keyed under one epoch so a single `invalidateCatalog` drops every
 * entry at once. Writes outside the admin routes and the ranking/membership jobs (vendor
 * sync, availability changes) surface within the TTL.
 */
export async function cachedCatalog<T>(
  cache: CacheAdapter | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const epoch = await cached(cache, CATALOG_EPOCH_KEY, CATALOG_CACHE_TTL_MS, async () =>
    randomUUID(),
  );
  return cached(cache, `gaming:catalog:${epoch}:${key}`, CATALOG_CACHE_TTL_MS, load);
}

export function invalidateCatalog(cache: CacheAdapter | undefined): Promise<void> {
  return invalidate(cache, CATALOG_EPOCH_KEY);
}
