import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Maps camelCase schema keys to snake_case SQL identifiers so generated
  // migrations match the runtime drizzle() instances (also set to snake_case).
  casing: 'snake_case',
  // The core add-ons share this one central migration history. Gated add-ons
  // (leaderboard, sportsbook, aggregator, player-management) own their own
  // drizzle.config + history and are intentionally NOT globbed here. Each new
  // core add-on with tables must be listed below (the scaffolder adds it).
  // Paths are relative to packages/core (the engine + outbox live in ./src/server/db).
  schema: [
    './src/server/db/outbox/schema.ts',
    './src/audit/schema/index.ts',
    './src/engagement/bonus/schema/index.ts',
    './src/engagement/chat/schema/index.ts',
    './src/cms/schema/index.ts',
    './src/compliance/schema/index.ts',
    './src/casino/gaming/schema/index.ts',
    './src/iam/schema/index.ts',
    './src/pam/identity/schema/index.ts',
    './src/casino/lobby/schema/index.ts',
    './src/engagement/notifications/schema/index.ts',
    './src/pam/profile/schema/index.ts',
    './src/wallet/schema/index.ts',
    './src/pam/tag/schema/index.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    // Prefer DATABASE_ADMIN_URL (the owner role) and fall back to DATABASE_URL
    // for single-role local/CI setups.
    url:
      process.env['DATABASE_ADMIN_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/oss_igaming',
  },
});
