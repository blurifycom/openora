// Isomorphic contract primitives folded from @blurifycom/{orpc-contract,shared-schemas,adapters} (ADR-0025).
// A module's own contract slice lives under that module's /contracts subpath, never here.
export * from './orpc/index.js';
export * from './schemas/index.js';
export * from './adapters/index.js';
export * from './kit.js';
// KycStatus ('verified'...) lives in ./schemas; KycVendorStatus ('approved'...) in ./adapters to avoid collision. See ADR-0025.
