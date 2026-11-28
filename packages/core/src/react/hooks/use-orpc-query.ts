import { useMemo } from 'react';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { AnyContractRouter } from '@orpc/contract';
import { useOrpcClient } from './use-orpc-client.js';

export function useOrpcQueryUtils<TContract extends AnyContractRouter>(contract: TContract) {
  const client = useOrpcClient(contract);
  return useMemo(() => createTanstackQueryUtils(client), [client]);
}
