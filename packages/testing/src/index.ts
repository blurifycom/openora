// Dev/test harness consumers run from a dev script. See ADR-0025.
export { setupTestDb, applyMigrations, type TestDb } from './db.js';
export { bootTestApp, type TestApp, type BootTestAppConfig } from './app.js';
export { asPlayer, asAdmin, type TestClient, type AdminCreds } from './request.js';
export { seedMinimal, type SeedMinimalOptions } from './seed.js';
export { seedDemoData } from './seed-demo-data.js';
export type { SeedAuth, SeedOptions, SeedResult } from './seed-demo-data.js';
