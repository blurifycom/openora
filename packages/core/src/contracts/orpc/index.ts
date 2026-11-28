import { populateContractRouterPaths, type ContractRouter } from '@orpc/contract';
import { healthContract } from './health.js';

// oxlint-disable-next-line typescript/no-explicit-any
export type AnyContract = ContractRouter<any>;

export function composeContract<T extends Record<string, AnyContract>>(slices: T) {
  return populateContractRouterPaths({ health: healthContract, ...slices });
}

export { healthContract } from './health.js';
