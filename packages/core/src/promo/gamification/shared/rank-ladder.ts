import type { RankPeriodicBasis } from '@openora/core/contracts';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { RankLadder, RankPeriodicPayout } from '../contract/index.js';
import { promoRankConfig, promoRankTier, type PromoRankTier } from '../schema/index.js';
import { RANK_PERIOD_KINDS } from './rank-period.js';

export const TIER_COLUMNS = {
  id: promoRankTier.id,
  key: promoRankTier.key,
  name: promoRankTier.name,
  position: promoRankTier.position,
  wagerThreshold: promoRankTier.wagerThreshold,
  rakebackPercent: promoRankTier.rakebackPercent,
  dailyBonus: promoRankTier.dailyBonus,
  weeklyBonus: promoRankTier.weeklyBonus,
  monthlyBonus: promoRankTier.monthlyBonus,
  levelUpBonus: promoRankTier.levelUpBonus,
  dailyBonusPercent: promoRankTier.dailyBonusPercent,
  weeklyBonusPercent: promoRankTier.weeklyBonusPercent,
  monthlyBonusPercent: promoRankTier.monthlyBonusPercent,
};

type LadderRow = Pick<PromoRankTier, keyof typeof TIER_COLUMNS | 'currency'>;

export async function readPeriodicPayout(db: DrizzleDb | DrizzleTx): Promise<RankPeriodicPayout> {
  const [config] = await db.select({ rewards: promoRankConfig.rewards }).from(promoRankConfig);
  const modeOf = (kind: (typeof RANK_PERIOD_KINDS)[number]) =>
    config?.rewards[kind]?.payout ?? 'bonus';
  return { daily: modeOf('daily'), weekly: modeOf('weekly'), monthly: modeOf('monthly') };
}

export const toLadder = (
  currency: string,
  tiers: readonly LadderRow[],
  periodicBasis: RankPeriodicBasis,
  periodicPayout: RankPeriodicPayout,
): RankLadder => ({
  currency,
  periodicBasis,
  periodicPayout,
  tiers: tiers.map(({ currency: _currency, ...tier }) => tier),
});
