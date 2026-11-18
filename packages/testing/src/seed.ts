import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { EXAMPLE_RANK_LADDER, seedDemoData, type SeedResult } from '@openora/core/seed/local';
import {
  createAuth,
  DRIZZLE,
  type DrizzleDb,
  Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { backfillLedgerGames } from '@openora/core/casino/seed/gaming';
import { ledgerPlayEligibilityProjection, ledgerRgLimits } from '@openora/core/wallet/seed';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import { backfillRgLimits } from '@openora/core/compliance/seed';
import { seedIam } from '@openora/core/iam/seed';
import { seedTag } from '@openora/core/pam/tag/seed';
import { seedDefaultWeightProfile } from '@openora/core/promo/seed/bonus';
import { seedRankLadder } from '@openora/core/promo/seed/gamification';
import { user, session, account, verification } from '@openora/core/pam/schema/identity';

export { EXAMPLE_RANK_LADDER };

export type SeedMinimalOptions = {
  /** Keep small for fast tests. */
  playerCount?: number;
  admin?: { email: string; password: string; name: string };
};

/**
 * Seed a small, deterministic fixture: IAM reference roles + a demo fixture
 * (admin + a few players + wallets + games) for tests.
 *
 * better-auth's drizzle adapter resolves models from the db's relational schema
 * (`db._.fullSchema`), so we build a schema-aware connection just for auth -
 * passing the tables via the adapter's `schema` option instead would trigger
 * strict admin-plugin field checks (eg `banned`). The plain container db is used
 * for the direct table inserts (players, wallets, ...).
 */
export async function seedMinimal(
  container: Container<CoreTokenCatalog>,
  options: SeedMinimalOptions = {},
): Promise<SeedResult> {
  const drizzleSvc = container.get(DRIZZLE);
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('seedMinimal: DATABASE_URL is not set (boot the app first)');
  }

  const authPool = new Pool({ connectionString: url });
  const authDb = drizzle(authPool, {
    schema: { user, session, account, verification },
    casing: 'snake_case',
  });
  // Library boundary: this seed-local drizzle instance carries a different schema generic
  // than core's DrizzleDb alias. Sanctioned cast, see conventions.
  const auth = createAuth({ db: authDb as unknown as DrizzleDb });

  try {
    await seedIam(drizzleSvc.db);
    await seedTag(drizzleSvc.db);
    await seedDefaultWeightProfile(drizzleSvc.db);
    await seedRankLadder(drizzleSvc.db, EXAMPLE_RANK_LADDER);
    const result = await seedDemoData({
      db: drizzleSvc.db,
      auth,
      playerCount: options.playerCount ?? 4,
      admin: options.admin ?? {
        email: 'admin@oss.dev',
        password: 'password1234',
        name: 'Platform Admin',
      },
    });
    // After the demo games exist: the round ledger only plays games it has projected.
    await backfillLedgerGames(drizzleSvc.db);
    // After the demo users exist: the ledger refuses a stake from a user it has not projected.
    await backfillPlayEligibility(drizzleSvc.db, ledgerPlayEligibilityProjection(drizzleSvc.db));
    // After any seeded limit: the ledger does not enforce a limit it has not projected.
    await backfillRgLimits(drizzleSvc.db, ledgerRgLimits(drizzleSvc.db));
    return result;
  } finally {
    await authPool.end();
  }
}
