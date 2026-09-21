import type { DrizzleDb } from '@openora/core/server';
import { promoRankTier } from '../schema/index.js';

const LADDER = [
  ['bronze', 'Bronze', '0', '1', '0.10', null, null],
  ['silver', 'Silver', '10000', '3', '0.50', null, '5'],
  ['gold', 'Gold', '50000', '5', '2', '10', '25'],
  ['crystal', 'Crystal', '250000', '7', '10', '50', '150'],
  ['master', 'Master', '1000000', '10', '25', '150', '500'],
  ['champion', 'Champion', '2500000', '10', '75', '400', '1500'],
  ['titan', 'Titan', '10000000', '10', '200', '1000', '5000'],
  ['legend', 'Legend', '50000000', '10', '500', '3000', '15000'],
] as const;

/**
 * The default rank ladder. Idempotent and never overwrites a tier an operator has already edited.
 */
export async function seedRankLadder(db: DrizzleDb): Promise<void> {
  await db
    .insert(promoRankTier)
    .values(
      LADDER.map(
        (
          [key, name, wagerThreshold, rakebackPercent, dailyBonus, weeklyBonus, monthlyBonus],
          position,
        ) => ({
          key,
          name,
          position,
          currency: 'USDT',
          wagerThreshold,
          rakebackPercent,
          dailyBonus,
          weeklyBonus,
          monthlyBonus,
        }),
      ),
    )
    .onConflictDoNothing();
}
