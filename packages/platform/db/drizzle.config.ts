import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/outbox/schema.ts',
    '../../modules/platform/*/src/schema/index.ts',
    '../../modules/player/*/src/schema/index.ts',
    '../../modules/backoffice/*/src/schema/index.ts',
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
