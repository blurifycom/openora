import { randomUUID } from 'node:crypto';
import type { CacheAdapter } from '@openora/core/contracts';
import { cached, invalidate } from '@openora/core/server';
import type { ListGamesInput } from '../contract/index.js';

const CATALOG_CACHE_TTL_MS = 30_000;
const CATALOG_EPOCH_KEY = 'gaming:catalog:epoch';

type PageInput = { page: number; limit: number };

export const catalogCacheKeys = {
  games: (input: ListGamesInput) => `games:${JSON.stringify(input)}`,
  game: (id: string) => `game:${id}`,
  gameBySlug: (slug: string) => `game-slug:${slug}`,
  providers: ({ page, limit }: PageInput) => `providers:${page}:${limit}`,
  provider: (slug: string) => `provider:${slug}`,
  categories: ({ page, limit }: PageInput) => `categories:${page}:${limit}`,
  category: (slug: string) => `category:${slug}`,
};

function catalogEntryKey(epoch: string, key: string): string {
  return `gaming:catalog:${epoch}:${key}`;
}

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
  return cached(cache, catalogEntryKey(epoch, key), CATALOG_CACHE_TTL_MS, load);
}

export function invalidateCatalog(cache: CacheAdapter | undefined): Promise<void> {
  return invalidate(cache, CATALOG_EPOCH_KEY);
}
