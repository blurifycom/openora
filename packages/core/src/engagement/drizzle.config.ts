import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Own migration history + own tracking table so it never collides with core or
// other add-on packages, and can be lifted out independently. See ADR-0020.
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
