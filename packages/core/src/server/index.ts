// @blurifycom/core/server - DI kernel, plugin-host, db, auth, and the domain-agnostic Hono app factory.
// Drizzle ORM and migration runner are the @blurifycom/core/server/orm + /migrate subpaths (ADR-0025).
export * from './kernel/index.js';
export * from './plugin-host/index.js';
export * from './db/index.js';
export * from './auth/index.js';
export * from './runtime/index.js';

// Disambiguate: ./db transitively re-exports a drizzle EventHandler that collides
// with the kernel EventBus's. Canonicalize to the kernel one (explicit wins).
export type { EventHandler } from './kernel/index.js';
