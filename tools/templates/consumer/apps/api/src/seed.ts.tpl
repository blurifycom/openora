/**
 * Reference-data seeder. Composes the module seeders you enable (e.g. IAM's
 * predefined roles) and runs them - convergent upserts, safe on every deploy.
 *
 * Standalone one-shot script (mirrors the migration runner): needs only a DB
 * connection, never boots the app. Add a module's seeder by importing + calling it.
 *
 * Usage: pnpm db:seed  (run after db:migrate). Requires DATABASE_URL.
 * Does NOT include demo data (fixtures, fake players) - that is dev-only.
 */
import { createDrizzleDb } from '@blurifycom/core/server';
import { seedRoles } from '@blurifycom/core/iam/seed';
// import additional module seeders here as you enable them

async function main() {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('Refusing to seed in production. This script is dev/local only.');
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL env var not set');
    process.exit(1);
  }

  const db = createDrizzleDb(databaseUrl);

  await seedRoles(db);
  // await seedOtherModule(db);
  console.log('Reference data seeded.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nSeed failed:', e);
    process.exit(1);
  });
