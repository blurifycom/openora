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

/** The rate row with the highest day at or below `current`. */
export function activeRakebackMilestone(
  milestones: readonly StreakRakebackMilestone[],
  current: number,
): StreakRakebackMilestone | null {
  return milestones.reduce<StreakRakebackMilestone | null>(
    (active, milestone) =>
      milestone.day <= current && (active === null || milestone.day > active.day)
        ? milestone
        : active,
    null,
  );
}
