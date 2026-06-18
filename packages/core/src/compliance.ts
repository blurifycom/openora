// Regulator-mandated sealed-token list + assertNoSealedProviders guard (ADR-0025).
export * from './compliance/sealed.js';
export { assertNoSealedProviders } from './compliance/assert.js';
export type { SealedContainerView } from './compliance/assert.js';
