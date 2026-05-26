export { DrizzleService } from './drizzle.service.js';
export { createDrizzleDb, setTenantId, type DrizzleDb } from './drizzle.js';

// The drizzle surface (tables + operators) lives at the `@oss/db/orm` subpath -
// a NestJS-free leaf so drizzle-kit can bundle module schemas without pulling in
// DrizzleService. Cross-workspace consumers (eg consumer, linked via `link:`)
// import drizzle from there to share @oss/db's single physical drizzle-orm copy.
export * as orm from './orm.js';
