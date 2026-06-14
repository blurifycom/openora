import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Core add-ons share this one central migration history. Gated add-ons
  // (leaderboard, sportsbook, aggregator, player-management) own their own
  // drizzle.config + history and are intentionally NOT globbed here. Each new
  // core add-on with tables must be listed below (the scaffolder adds it).
  schema: [
    './src/outbox/schema.ts',
    '../../addons/audit/src/schema/index.ts',
    '../../domains/engagement/src/bonus/schema/index.ts',
    '../../domains/engagement/src/chat/schema/index.ts',
    '../../domains/cms/src/schema/index.ts',
    '../../domains/pam/src/compliance/schema/index.ts',
    '../../domains/casino/src/gaming/schema/index.ts',
    '../../addons/iam/src/schema/index.ts',
    '../../domains/pam/src/identity/schema/index.ts',
    '../../domains/casino/src/lobby/schema/index.ts',
    '../../domains/engagement/src/notifications/schema/index.ts',
    '../../domains/pam/src/profile/schema/index.ts',
    '../../domains/wallet/src/schema/index.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    // Migrations run DDL that needs owner/superuser privileges: CREATE ROLE,
    // ALTER DEFAULT PRIVILEGES, ENABLE/FORCE ROW LEVEL SECURITY, CREATE POLICY
    // (ADR-0018, migrations 0006/0007). The RLS-enforced `oss_app` role
    // (DATABASE_URL in production) cannot run these - drizzle-kit migrate would
    // fail. Prefer DATABASE_ADMIN_URL (the owner / oss_system role) and fall back
    // to DATABASE_URL for single-role local/CI setups.
    url:
      process.env['DATABASE_ADMIN_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/oss_igaming',
  },
});
