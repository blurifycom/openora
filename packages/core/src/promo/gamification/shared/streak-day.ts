import { moneyMax } from '@openora/core/server';
import type { StreakRakebackMilestone } from '../contract/index.js';

export const DAY_MS = 86_400_000;

export const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export const yesterdayOf = (now: Date) => isoDate(new Date(now.getTime() - DAY_MS));

export const isStreakLive = (lastQualifyingDay: string | null, now: Date) =>
  lastQualifyingDay === isoDate(now) || lastQualifyingDay === yesterdayOf(now);

export type StreakRate = Pick<
  StreakRakebackMilestone,
  'unrankedRatePercent' | 'rankedUpliftPercent'
>;

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
              unrankedRatePercent: moneyMax(
                best.unrankedRatePercent,
                milestone.unrankedRatePercent,
              ),
              rankedUpliftPercent: moneyMax(
                best.rankedUpliftPercent,
                milestone.rankedUpliftPercent,
              ),
            },
      null,
    );
}
