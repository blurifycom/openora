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
    '../../addons/bonus/src/schema/index.ts',
    '../../addons/chat/src/schema/index.ts',
    '../../addons/cms/src/schema/index.ts',
    '../../addons/compliance/src/schema/index.ts',
    '../../addons/gaming/src/schema/index.ts',
    '../../addons/iam/src/schema/index.ts',
    '../../addons/identity/src/schema/index.ts',
    '../../addons/localization/src/schema/index.ts',
    '../../addons/lobby/src/schema/index.ts',
    '../../addons/notifications/src/schema/index.ts',
    '../../addons/profile/src/schema/index.ts',
    '../../addons/wallet/src/schema/index.ts',
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
