'use client';

import { useMemo } from 'react';
import type { AnyContractRouter } from '@orpc/contract';
import { useApiClient } from '../context/api-client.js';
import { createClient, type OssClient } from '../client.js';

/** Returns a typed oRPC client memoized per `baseUrl` + `contract` - pass the slice your domain needs. */
export function useOrpcClient<TContract extends AnyContractRouter>(
  contract: TContract,
): OssClient<TContract> {
  const { baseUrl } = useApiClient();
  return useMemo(() => createClient(contract, { baseUrl }), [baseUrl, contract]);
}
