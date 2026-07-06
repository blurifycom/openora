import { useMemo } from 'react';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { AnyContractRouter } from '@orpc/contract';
import { useOrpcClient } from './use-orpc-client.js';

/**
 * Contract-generic react-query utils (queryOptions/mutationOptions/key) over the typed oRPC client.
 * */
export function useOrpcQueryUtils<TContract extends AnyContractRouter>(contract: TContract) {
  const client = useOrpcClient(contract);
  return useMemo(() => createTanstackQueryUtils(client), [client]);
}
