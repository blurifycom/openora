// @oss/core/compliance - regulator-mandated sealed-token list + invariants.
// Owns the canonical SEALED_TOKENS (with regulatory citations per token) and the
// assertNoSealedProviders runtime guard. Folded in from the former
// @oss/compliance-invariants package (ADR-0025).
export * from './compliance/sealed.js';
export { assertNoSealedProviders } from './compliance/assert.js';
export type { SealedContainerView } from './compliance/assert.js';
