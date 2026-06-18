import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Own migration history + own tracking table (ADR-0020).
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./aggregator/schema/index.ts'],
  out: './drizzle/migrations',
  migrations: {
    table: '__drizzle_migrations_addon_aggregator',
    schema: 'drizzle',
  },
  dbCredentials: {
    url:
      process.env['DATABASE_ADMIN_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/oss_igaming',
  },
});
