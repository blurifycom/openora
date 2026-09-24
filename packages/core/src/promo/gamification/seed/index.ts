import type { DrizzleDb } from '@openora/core/server';
import type { RankConfig } from '../contract/index.js';
import { promoRankConfig, promoRankTier } from '../schema/index.js';

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

export type RankLadderSeed = {
  /** What thresholds and bonuses are counted and paid in. Wagers in other currencies convert. */
  currency: string;
  /** Lowest tier first; the first must start at zero. */
  tiers: RankTierSeed[];
  config: RankConfig;
};

/**
 * Seeds a ladder and its settings. What a tier costs and pays, and in which currency, is an
 * operator's pricing, so it is passed in rather than shipped with the package.
 *
 * Idempotent, and it never overwrites a tier or a setting an operator has already edited.
 */
export async function seedRankLadder(db: DrizzleDb, ladder: RankLadderSeed): Promise<void> {
  if (ladder.tiers.length === 0) {
    return;
  }
  await db
    .insert(promoRankTier)
    .values(
      ladder.tiers.map((tier, position) => ({ ...tier, position, currency: ladder.currency })),
    )
    .onConflictDoNothing();
  await db.insert(promoRankConfig).values(ladder.config).onConflictDoNothing();
}
