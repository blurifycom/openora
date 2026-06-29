import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Own migration history + tracking table, co-located with the module's schema.
// One DB shared with sibling modules, but one journal per module so a module can
// be extracted to its own package without history surgery. See ADR-0020/0027.
export default defineConfig({
  dialect: 'postgresql',
  casing: 'snake_case',
  schema: ['./schema/index.ts'],
  out: './drizzle/migrations',
  migrations: {
    table: '__drizzle_migrations_cms',
    schema: 'drizzle',
  },
  dbCredentials: {
    url:
      process.env['DATABASE_ADMIN_URL'] ??
      process.env['DATABASE_URL'] ??
      'postgresql://postgres:postgres@localhost:5432/oss_igaming',
  },
});
