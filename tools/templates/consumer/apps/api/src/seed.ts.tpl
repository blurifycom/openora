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
import { createDrizzleDb } from '@openora/core/server';
import { backfillLedgerGames } from '@openora/core/casino/seed/gaming';
import { seedRoles } from '@openora/core/iam/seed';
import { backfillRgLimits } from '@openora/core/compliance/seed';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import { seedTag } from '@openora/core/pam/tag/seed';
import {
  ledgerPlayEligibilityProjection,
  ledgerRgLimits,
  seedAutoWithdrawalConfig,
} from '@openora/core/wallet/seed';
import { seedDefaultWeightProfile } from '@openora/core/promo/seed/bonus';
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
  await seedTag(db);
  await seedAutoWithdrawalConfig(db);
  // Without it, a bonus with no offer behind it - a gift, a rain drop, a hand-issued grant -
  // resolves no weight profile and is refused.
  await seedDefaultWeightProfile(db);
  // The round ledger refuses a round on a game it has not projected; this projects every
  // catalogue game, so run it after each import that bypassed GAMING_COMMANDS.notifyGames*.
  await backfillLedgerGames(db);
  // The ledger refuses a stake from a user it has not projected; this projects every user.
  await backfillPlayEligibility(db, ledgerPlayEligibilityProjection(db));
  // The same for responsible-gambling limits: the ledger does not enforce an unprojected one.
  await backfillRgLimits(db, ledgerRgLimits(db));
  console.log('Reference data seeded.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nSeed failed:', e);
    process.exit(1);
  });
