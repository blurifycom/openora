import type { RankLadder } from '../contract/index.js';
import { promoRankTier, type PromoRankTier } from '../schema/index.js';

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
};

type LadderRow = Pick<PromoRankTier, keyof typeof TIER_COLUMNS | 'currency'>;

export const toLadder = (currency: string, tiers: readonly LadderRow[]): RankLadder => ({
  currency,
  tiers: tiers.map(({ currency: _currency, ...tier }) => tier),
});
