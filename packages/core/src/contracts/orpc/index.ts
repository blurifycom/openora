import { populateContractRouterPaths, type ContractRouter } from '@orpc/contract';
import { healthContract } from './health.js';

// This package is NOT an aggregator. It owns only `health` (a platform route, not
// a domain) and the `composeContract` helper. Each module OWNS its route contract
// (exported as `@oss/<domain>/contracts/<slice>` or `@oss-addons/<name>/contract`)
// - that is the single source of truth. The runtime contract is assembled by the
// COMPOSITION ROOT (apps/api / a downstream consumer) from exactly the slices its
// edition enables, so a build can ship any subset of modules (PAM-only, premium
// add-ons) without this shared package depending on any of them. See ADR-0021.

// The shape is genuinely unknown at the composition boundary (an external oRPC
// generic) - the documented `any` exception for an external library's surface.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyContract = ContractRouter<any>;

// Compose a runtime oRPC contract from a set of route slices. `health` is always
// included (it is owned here, not by any module). The composition root calls this
// with the slices its edition enables - aggregation lives in the consumer, never
// in a shared package. Returns the populated router so the caller gets full
// inference (a typed client links against `typeof composeContract(...)`).
export function composeContract<T extends Record<string, AnyContract>>(slices: T) {
  return populateContractRouterPaths({ health: healthContract, ...slices });
}

export { healthContract } from './health.js';
