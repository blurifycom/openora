// @oss/core/server - the node engine: DI kernel, plugin-host, db, auth, and the
// domain-agnostic Hono app factory (createApp). Folded in from the former
// @oss/{kernel,plugin-host,db,auth,api-runtime} packages (ADR-0025). The drizzle
// surface (./db orm) and the migration runner (./db migrate) are exposed as the
// dedicated @oss/core/server/orm + @oss/core/server/migrate subpaths.
export * from './kernel/index.js';
export * from './plugin-host/index.js';
export * from './db/index.js';
export * from './auth/index.js';
export * from './runtime/index.js';

// Disambiguate: ./db transitively re-exports a drizzle EventHandler that collides
// with the kernel EventBus's. Canonicalize to the kernel one (explicit wins).
export type { EventHandler } from './kernel/index.js';
