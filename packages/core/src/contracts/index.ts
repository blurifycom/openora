// @oss/core/contracts - isomorphic contract primitives. Holds ONLY cross-cutting
// primitives: composeContract + healthContract (orpc/), base money/id/pagination
// + shared zod schemas (schemas/), and the ports/tokens incl. sealed-token
// factories (adapters/). A module's own contract slice lives under that module's
// /contracts subpath, never here. Folded in from the former @oss/{orpc-contract,
// shared-schemas,adapters} packages (ADR-0025).
export * from './orpc/index.js';
export * from './schemas/index.js';
export * from './adapters/index.js';
// Note: the player-domain KycStatus ('verified'...) lives in ./schemas; the KYC
// vendor-adapter enum ('approved'...) is exported as KycVendorStatus from
// ./adapters so the two no longer collide. See ADR-0025.
