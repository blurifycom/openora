import { moneyCompare } from '@openora/core/server';
import type { StreakRakebackMilestone } from '../contract/index.js';

export const DAY_MS = 86_400_000;

export const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export const yesterdayOf = (now: Date) => isoDate(new Date(now.getTime() - DAY_MS));

/**
 * A streak still counts only while its last qualifying day is today or yesterday. The daily close
 * resets a broken one, but it runs after midnight, so a reader must not wait for it.
 */
export const isStreakLive = (lastQualifyingDay: string | null, now: Date) =>
  lastQualifyingDay !== null &&
  (lastQualifyingDay === isoDate(now) || lastQualifyingDay === yesterdayOf(now));

export type StreakRate = Pick<
  StreakRakebackMilestone,
  'unrankedRatePercent' | 'rankedUpliftPercent'
>;

/**
 * The best rate the streak has unlocked: for each formula, the highest percentage among the rows
 * at or below `current`. A later row with a lower rate never lowers it, because an unlocked rate
 * holds until the player misses a day.
 */
export function activeRakebackRate(
  milestones: readonly StreakRakebackMilestone[],
  current: number,
): StreakRate | null {
  return milestones
    .filter((milestone) => milestone.day <= current)
    .reduce<StreakRate | null>(
      (best, milestone) =>
        best === null
          ? {
              unrankedRatePercent: milestone.unrankedRatePercent,
              rankedUpliftPercent: milestone.rankedUpliftPercent,
            }
          : {
              unrankedRatePercent:
                moneyCompare(milestone.unrankedRatePercent, best.unrankedRatePercent) > 0
                  ? milestone.unrankedRatePercent
                  : best.unrankedRatePercent,
              rankedUpliftPercent:
                moneyCompare(milestone.rankedUpliftPercent, best.rankedUpliftPercent) > 0
                  ? milestone.rankedUpliftPercent
                  : best.rankedUpliftPercent,
            },
      null,
    );
}
