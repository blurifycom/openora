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
    url: process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/oss_igaming',
  },
});
