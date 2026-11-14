/**
 * Local seeder: reference data (roles, tags, default configs), a super-admin from ADMIN_EMAIL /
 * ADMIN_PASSWORD, and demo players, games, wallets and chat so the backoffice has something to show.
 *
 * Standalone one-shot script (mirrors the migration runner): needs only a DB connection, never
 * boots the app. Safe to re-run: reference data converges, demo content is recreated and the admin
 * password is reset to ADMIN_PASSWORD. Local only: refuses NODE_ENV=production and any database
 * host other than localhost. Never run it in a release pipeline.
 *
 * Usage: pnpm db:seed  (run after db:migrate). Requires DATABASE_URL.
 */
import { seedLocalData } from '@openora/core/seed/local';

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL env var not set');
    process.exit(1);
  }

  const result = await seedLocalData({
    databaseUrl,
    admin: {
      email: process.env['ADMIN_EMAIL'] ?? 'admin@oss.dev',
      password: process.env['ADMIN_PASSWORD'] ?? 'password1234',
    },
    playerCount: Number(process.env['SEED_PLAYERS'] || 36),
    log: (m) => console.log(`  ${m}`),
  });

  console.log(`\nSeeded ${result.players} players, ${result.games} games.`);
  console.log(`Log in to the backoffice: ${result.adminEmail} / ${result.adminPassword}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nSeed failed:', e);
    process.exit(1);
  });
