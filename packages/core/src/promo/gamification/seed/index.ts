import type { DrizzleDb } from '@openora/core/server';
import { promoRankTier } from '../schema/index.js';

export type RankTierSeed = {
  key: string;
  name: string;
  wagerThreshold: string;
  rakebackPercent: string;
  dailyBonus?: string | null;
  weeklyBonus?: string | null;
  monthlyBonus?: string | null;
  levelUpBonus?: string | null;
};

const LADDER_CURRENCY = 'USDT';

/**
 * Seeds a ladder in array order, lowest tier first. What a tier costs and pays is an operator's
 * pricing, so the ladder is passed in rather than shipped with the package.
 *
 * Idempotent, and it never overwrites a tier an operator has already edited.
 */
export async function seedRankLadder(db: DrizzleDb, tiers: RankTierSeed[]): Promise<void> {
  if (tiers.length === 0) {
    return;
  }
  await db
    .insert(promoRankTier)
    .values(tiers.map((tier, position) => ({ ...tier, position, currency: LADDER_CURRENCY })))
    .onConflictDoNothing();
}
