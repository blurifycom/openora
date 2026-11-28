'use client';

import { useMemo } from 'react';
import type { AnyContractRouter } from '@orpc/contract';
import { useApiClient } from '../context/api-client.js';
import { createClient, type OssClient } from '../client.js';

export function useOrpcClient<TContract extends AnyContractRouter>(
  contract: TContract,
): OssClient<TContract> {
  const { baseUrl } = useApiClient();
  return useMemo(() => createClient(contract, { baseUrl }), [baseUrl, contract]);
}
