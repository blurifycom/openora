import { createAuth, createDrizzleDb } from '@openora/core/server';
import { seedIam } from '@openora/core/iam/seed';
import { seedTag } from '@openora/core/pam/tag/seed';
import { backfillLedgerGames } from '@openora/core/casino/seed/gaming';
import {
  ledgerPlayEligibilityProjection,
  ledgerRgLimits,
  seedAutoWithdrawalConfig,
} from '@openora/core/wallet/seed';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import { backfillRgLimits } from '@openora/core/compliance/seed';
import { seedDefaultWeightProfile } from '@openora/core/promo/seed/bonus';
import { seedRankLadder, type RankLadderSeed } from '@openora/core/promo/seed/gamification';
import { seedChatCommands } from '@openora/core/engagement/seed/chat-commands';
import {
  DEFAULT_PAYOUT_ANCHORS,
  DEFAULT_RANK_PERK_PRODUCTS,
} from '@openora/core/promo/contracts/gamification';
import { WAGER_PRODUCTS } from '@openora/core/contracts';
import { user, session, account, verification, twoFactor } from '@openora/core/pam/schema/identity';
import { seedDemoData, type SeedResult } from './seed-demo-data.js';

export {
  seedDemoData,
  type SeedAuth,
  type SeedOptions,
  type SeedResult,
} from './seed-demo-data.js';

export const EXAMPLE_RANK_LADDER: RankLadderSeed = {
  currency: 'USDT',
  tiers: [
    { key: 'bronze', name: 'Bronze', wagerThreshold: '0', rakebackPercent: '1', dailyBonus: '1' },
    {
      key: 'silver',
      name: 'Silver',
      wagerThreshold: '10000',
      rakebackPercent: '3',
      dailyBonus: '5',
      monthlyBonus: '50',
      levelUpBonus: '10',
    },
    {
      key: 'gold',
      name: 'Gold',
      wagerThreshold: '100000',
      rakebackPercent: '5',
      dailyBonus: '20',
      weeklyBonus: '100',
      monthlyBonus: '400',
      levelUpBonus: '50',
    },
    {
      key: 'platinum',
      name: 'Platinum',
      wagerThreshold: '1000000',
      rakebackPercent: '10',
      dailyBonus: '100',
      weeklyBonus: '500',
      monthlyBonus: '2000',
      levelUpBonus: '250',
    },
  ],
  config: {
    payoutAnchors: DEFAULT_PAYOUT_ANCHORS,
    payInPlayerCurrency: false,
    periodicRequiresActivity: true,
    eligibleProducts: [...WAGER_PRODUCTS],
    rakebackEligibleProducts: [...DEFAULT_RANK_PERK_PRODUCTS],
    rankChallengeEligibleProducts: [...DEFAULT_RANK_PERK_PRODUCTS],
    rewards: {
      levelUp: { wageringMultiplier: '1', expiryDays: 7 },
      daily: { wageringMultiplier: '1', expiryDays: 1 },
      weekly: { wageringMultiplier: '1', expiryDays: 7 },
      monthly: { wageringMultiplier: '1', expiryDays: 30 },
    },
  },
};

export type SeedLocalOptions = {
  databaseUrl: string;
  admin: { email: string; password: string; name?: string };
  playerPassword?: string;
  playerCount?: number;
  log?: (message: string) => void;
};

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'postgres']);

function assertLocalDatabase(databaseUrl: string): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('seedLocalData refuses to run with NODE_ENV=production: it wipes demo tables.');
  }
  const url = new URL(databaseUrl);
  const host = url.searchParams.get('host') ?? url.hostname;
  if (!LOCAL_DB_HOSTS.has(host) && process.env['OPENORA_ALLOW_REMOTE_SEED'] !== '1') {
    throw new Error(
      `seedLocalData refuses to wipe the database at ${host}: it only seeds a local database. ` +
        'Set OPENORA_ALLOW_REMOTE_SEED=1 if this database is disposable.',
    );
  }
}

export async function seedLocalData(options: SeedLocalOptions): Promise<SeedResult> {
  assertLocalDatabase(options.databaseUrl);
  const log = options.log ?? (() => {});
  const db = createDrizzleDb(options.databaseUrl);
  const auth = createAuth({ db, schema: { user, session, account, verification, twoFactor } });

  await seedIam(db);
  await seedTag(db);
  await seedAutoWithdrawalConfig(db);
  await seedDefaultWeightProfile(db);
  await seedRankLadder(db, EXAMPLE_RANK_LADDER);
  await seedChatCommands(db);
  log('Reference data ready (roles, tags, configs, rank ladder, chat commands).');

  const result = await seedDemoData({
    db,
    auth,
    admin: { name: 'Platform Admin', ...options.admin },
    ...(options.playerPassword === undefined ? {} : { password: options.playerPassword }),
    ...(options.playerCount === undefined ? {} : { playerCount: options.playerCount }),
    log,
  });
  await backfillLedgerGames(db);
  log('Round ledger games projected.');
  await backfillPlayEligibility(db, ledgerPlayEligibilityProjection(db));
  log('Ledger play eligibility projected.');
  await backfillRgLimits(db, ledgerRgLimits(db));
  log('Ledger limits projected.');
  return result;
}
