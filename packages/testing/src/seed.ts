import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedDemoData, type SeedResult } from './seed-demo-data.js';
import {
  createAuth,
  DRIZZLE,
  type DrizzleDb,
  Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { seedIam } from '@openora/core/iam/seed';
import { seedTag } from '@openora/core/pam/tag/seed';
import { seedDefaultWeightProfile } from '@openora/core/promo/seed/bonus';
import { seedRankLadder } from '@openora/core/promo/seed/gamification';
import { user, session, account, verification } from '@openora/core/pam/schema/identity';

const EXAMPLE_RANK_LADDER = [
  { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1', dailyBonus: '1' },
  {
    key: 'silver',
    name: 'Silver',
    wagerThreshold: '10000',
    rakebackPercent: '3',
    dailyBonus: '5',
    monthlyBonus: '50',
  },
  {
    key: 'gold',
    name: 'Gold',
    wagerThreshold: '100000',
    rakebackPercent: '5',
    dailyBonus: '20',
    weeklyBonus: '100',
    monthlyBonus: '400',
  },
  {
    key: 'platinum',
    name: 'Platinum',
    wagerThreshold: '1000000',
    rakebackPercent: '10',
    dailyBonus: '100',
    weeklyBonus: '500',
    monthlyBonus: '2000',
  },
];

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
    return await seedDemoData({
      db: drizzleSvc.db,
      auth,
      playerCount: options.playerCount ?? 4,
      admin: options.admin ?? {
        email: 'admin@oss.dev',
        password: 'password1234',
        name: 'Platform Admin',
      },
    });
  } finally {
    await authPool.end();
  }
}
