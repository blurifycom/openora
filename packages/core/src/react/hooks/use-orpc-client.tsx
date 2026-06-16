'use client';

import { useMemo } from 'react';
import type { AnyContractRouter } from '@orpc/contract';
import { useApiClient } from '../context/api-client.js';
import { createClient, type OssClient } from '../client.js';

/**
 * Returns a fully-typed oRPC client built against the CALLER's contract.
 *
 * The platform is headless/modular, so the SDK does not bake in a contract -
 * each `@oss/<domain>/react` hook (or a consumer) passes the contract slice it
 * needs. The client is memoized per `baseUrl` (from `ApiClientProvider`) +
 * `contract`, so React Query's cache and the client share a stable identity.
 *
 * Cookies forward by default (`credentials: 'include'`).
 */
export function useOrpcClient<TContract extends AnyContractRouter>(
  contract: TContract,
): OssClient<TContract> {
  const { baseUrl } = useApiClient();
  return useMemo(() => createClient(contract, { baseUrl }), [baseUrl, contract]);
}
