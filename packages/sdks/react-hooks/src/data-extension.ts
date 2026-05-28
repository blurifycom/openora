'use client';

import { useQuery, type QueryKey, type UseQueryResult } from '@tanstack/react-query';

/**
 * Inject extra data into a page's query graph from a plugin slot.
 *
 * Two plugins reading the same `(pluginId, key)` share a single fetch (TanStack
 * Query coalesces by key). Use this when a slot needs data the host page didn't
 * load - eg a "VIP" column reading vip-tier rows, a "Risk Score" tab reading
 * harm-markers, etc.
 *
 * Cache key is namespaced `['oss-ext', pluginId, key, ...args]` so extension
 * data never collides with core hooks (`['player', 'list', ...]`).
 *
 * @example
 *   const { data, isLoading } = useDataExtension(
 *     'vip-tier',
 *     'rows',
 *     async () => client.vip.list(),
 *   );
 *
 * If two plugins call with the same `(pluginId, key, args)` they share the
 * fetch + cache slot - the second call dedupes on the first.
 */
export function useDataExtension<TData, TError = Error>(
  pluginId: string,
  key: string,
  fetcher: () => Promise<TData>,
  args: ReadonlyArray<unknown> = [],
): UseQueryResult<TData, TError> {
  const queryKey: QueryKey = ['oss-ext', pluginId, key, ...args];
  return useQuery<TData, TError>({
    queryKey,
    queryFn: fetcher,
  });
}

/** Build the namespaced query key for a data extension - exposed for tests + invalidations. */
export function dataExtensionKey(
  pluginId: string,
  key: string,
  args: ReadonlyArray<unknown> = [],
): QueryKey {
  return ['oss-ext', pluginId, key, ...args];
}
