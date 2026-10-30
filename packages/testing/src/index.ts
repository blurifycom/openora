// Dev/test harness consumers run from a dev script. See ADR-0025.
export { setupTestDb, applyMigrations, type TestDb } from './db.js';
export { bootTestApp, type TestApp, type BootTestAppConfig } from './app.js';
export {
  asPlayer,
  asAdmin,
  registrationRequestHeaders,
  type TestClient,
  type AdminCreds,
} from './request.js';
export {
  forceEmailVerified,
  registerPlayer,
  registerAndMaterializePlayer,
  submitRegistration,
  uniqueUsername,
  verificationOtpFor,
  verifyEmailByOtp,
  waitForEmail,
  type RegisterPlayerInput,
} from './register.js';
export { capturedEmailsFor, clearCapturedEmails, type CapturedEmail } from './captured-emails.js';
export { seedMinimal, type SeedMinimalOptions } from './seed.js';
export { seedDemoData } from './seed-demo-data.js';
export type { SeedAuth, SeedOptions, SeedResult } from './seed-demo-data.js';
export { bootE2e, closeE2e, type E2e, type BootE2eOptions } from './e2e.js';
export {
  assignIamRoleByKey,
  assignTag,
  deactivateUser,
  newPlayer,
  newStaff,
  readJson,
  registerChatter,
  roleIdByKey,
  verifyKyc,
  type Chatter,
  type NamedAccount,
} from './helpers.js';
