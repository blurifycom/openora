import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Each add-on package owns its own migration history, kept in its own folder and
// tracked in its own `__drizzle_migrations_*` table so it never collides with the
// core history (packages/core) or other add-on packages. This is what lets
// the package be lifted out and published without dragging the core migration log
// with it. See docs/adr/0020-editions-and-add-on-modules.md.
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./leaderboard/schema/index.ts'],
  out: './drizzle/migrations',
  migrations: {
    table: '__drizzle_migrations_addon_leaderboard',
    schema: 'drizzle',
  },
  dbCredentials: {
    url:
      process.env['DATABASE_ADMIN_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/oss_igaming',
  },
});
