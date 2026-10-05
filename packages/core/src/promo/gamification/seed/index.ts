import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { RankConfig, StreakConfig } from '../contract/index.js';
import {
  promoRankChallengeTier,
  promoRankConfig,
  promoRankTier,
  promoStreakConfig,
} from '../schema/index.js';

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
 *
 * Passing a transaction does not by itself exclude a concurrent admin save: that save locks
 * `promo_rank_tier` rows with `FOR UPDATE`, which locks nothing on an empty ladder. A caller that
 * needs the check-then-install to be exclusive takes a table lock first, e.g.
 * `LOCK TABLE promo_rank_tier IN SHARE ROW EXCLUSIVE MODE`.
 */
export async function seedRankLadder(
  db: DrizzleDb | DrizzleTx,
  ladder: RankLadderSeed,
): Promise<void> {
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

export type StreakSeed = StreakConfig;

/**
 * Seeds the streak config, mirroring `seedRankLadder`: idempotent, never overwrites a setting an
 * operator has already edited.
 */
export async function seedStreakConfig(db: DrizzleDb, config: StreakSeed): Promise<void> {
  await db.insert(promoStreakConfig).values(config).onConflictDoNothing();
}

export type RankChallengeTierSeed = {
  key: string;
  name: string;
  wagerThreshold: string;
  cashAmount?: string | null;
  physicalItem?: string | null;
};

export type RankChallengeLadderSeed = {
  currency: string;
  /** Lowest threshold first. */
  tiers: RankChallengeTierSeed[];
};

/**
 * Seeds the Rank Challenge ladder, mirroring `seedRankLadder`: idempotent (unique on `key` and
 * `position`), never overwrites a tier an operator has already edited.
 */
export async function seedRankChallengeLadder(
  db: DrizzleDb,
  ladder: RankChallengeLadderSeed,
): Promise<void> {
  if (ladder.tiers.length === 0) {
    return;
  }
  await db
    .insert(promoRankChallengeTier)
    .values(
      ladder.tiers.map((tier, position) => ({
        ...tier,
        position,
        currency: ladder.currency,
        cashAmount: tier.cashAmount ?? null,
        physicalItem: tier.physicalItem ?? null,
      })),
    )
    .onConflictDoNothing();
}
