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
  playerCount?: number;
  admin?: { email: string; password: string; name: string };
};

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
    await backfillLedgerGames(drizzleSvc.db);
    await backfillPlayEligibility(drizzleSvc.db, ledgerPlayEligibilityProjection(drizzleSvc.db));
    await backfillRgLimits(drizzleSvc.db, ledgerRgLimits(drizzleSvc.db));
    return result;
  } finally {
    await authPool.end();
  }
}
