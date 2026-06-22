import { populateContractRouterPaths, type ContractRouter } from '@orpc/contract';
import { healthContract } from './health.js';

// Not an aggregator - owns only `health` and `composeContract`. Each module owns
// its route contract; the consumer's composition root assembles the runtime
// contract from exactly the slices its edition enables. See ADR-0021.

// Genuinely unknown at the composition boundary (external oRPC generic) - the
// documented `any` exception for an external library's untyped surface.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyContract = ContractRouter<any>;

export function composeContract<T extends Record<string, AnyContract>>(slices: T) {
  return populateContractRouterPaths({ health: healthContract, ...slices });
}

export { healthContract } from './health.js';
