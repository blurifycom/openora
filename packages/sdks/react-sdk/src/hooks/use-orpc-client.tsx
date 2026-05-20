'use client';

import { useMemo } from 'react';
import { useApiClient } from '../context/api-client.js';
import { createClient, type OssClient } from '../client.js';

/**
 * Returns a fully-typed oRPC client built against the OSS contract.
 *
 * The client is memoized per `baseUrl` (from `ApiClientProvider`). Each call
 * site reuses the same instance, so React Query's cache and the client share
 * a stable identity.
 *
 * Cookies forward by default (`credentials: 'include'`).
 */
export function useOrpcClient(): OssClient {
  const { baseUrl } = useApiClient();
  return useMemo(() => createClient({ baseUrl }), [baseUrl]);
}
