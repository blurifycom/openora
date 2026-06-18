export { setupTestDb, applyMigrations, type TestDb } from './db.js';
export { bootTestApp, type TestApp, type BootTestAppConfig } from './app.js';
export { asPlayer, asAdmin, type TestClient, type AdminCreds } from './request.js';
export { seedMinimal, type SeedMinimalOptions } from './seed.js';
// Demo-data seeding is a dev/test concern (not part of the runtime engine). It
// reads domain schemas, so it lives in this dev/test harness package, not in
// @oss/core. Consumers run it from a dev script. See ADR-0025.
export { seedDemoData } from './seed-demo-data.js';
export type { SeedAuth, SeedOptions, SeedResult } from './seed-demo-data.js';
