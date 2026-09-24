import type { RankPayoutAnchors } from '../contract/index.js';

/** The kinds that pay for a period, and therefore accumulate one. */
export const RANK_PERIOD_KINDS = ['daily', 'weekly', 'monthly'] as const;

export type RankPeriodKind = (typeof RANK_PERIOD_KINDS)[number];

export type RankPeriod = {
  /** Inclusive. */
  start: Date;
  /** Exclusive: the instant the period closed. */
  end: Date;
  /** The grant's `sourceRef`: one payout per player per period, however often the job runs. */
  sourceRef: string;
};

const DAY_MS = 86_400_000;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const hourKey = (date: Date) => String(date.getUTCHours()).padStart(2, '0');

/** ISO-8601 weekday of a date: 1 is Monday, 7 is Sunday. */
const isoWeekday = (date: Date) => date.getUTCDay() || 7;

/**
 * The key of the period `now` falls inside - the one still being wagered toward. It is the same
 * key the payout will ask for once that period closes, so a counter written during the period
 * and the payout that reads it always agree.
 */
export function openPeriodKey(kind: RankPeriodKind, now: Date, anchors: RankPayoutAnchors): string {
  // The open period begins where the last complete one ended.
  const start = lastCompletePeriod(kind, now, anchors).end;
  return keyFor(kind, start);
}

function keyFor(kind: RankPeriodKind, start: Date) {
  if (kind === 'daily') {
    return `rank-daily:${isoDate(start)}T${hourKey(start)}`;
  }
  return `rank-${kind}:${isoDate(start)}`;
}

/**
 * The last period that has fully closed by `now`, from the operator's anchors. The anchor sets
 * both the moment a period closes and the window it covers, so a payout can never run at one
 * time and pay for another. Everything is UTC: a rank does not move with the reader's clock.
 */
export function lastCompletePeriod(
  kind: RankPeriodKind,
  now: Date,
  anchors: RankPayoutAnchors,
): RankPeriod {
  if (kind === 'daily') {
    const end = atHour(now, anchors.dailyHour);
    const start = new Date(end.getTime() - DAY_MS);
    return { start, end, sourceRef: keyFor('daily', start) };
  }

  if (kind === 'weekly') {
    const end = lastWeekdayAtHour(now, anchors.weeklyDay, anchors.dailyHour);
    const start = new Date(end.getTime() - 7 * DAY_MS);
    return { start, end, sourceRef: keyFor('weekly', start) };
  }

  const end = lastMonthDayAtHour(now, anchors.monthlyDay, anchors.dailyHour);
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, end.getUTCDate(), end.getUTCHours()),
  );
  return { start, end, sourceRef: keyFor('monthly', start) };
}

/** The most recent `hour:00` that is not in the future. */
function atHour(now: Date, hour: number) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
  return new Date(today <= now.getTime() ? today : today - DAY_MS);
}

/** The most recent `weekday` at `hour` that is not in the future. */
function lastWeekdayAtHour(now: Date, weekday: number, hour: number) {
  const candidate = atHour(now, hour);
  const back = (isoWeekday(candidate) - weekday + 7) % 7;
  return new Date(candidate.getTime() - back * DAY_MS);
}

/** The most recent `dayOfMonth` at `hour` that is not in the future. */
function lastMonthDayAtHour(now: Date, dayOfMonth: number, hour: number) {
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth, hour);
  return new Date(
    thisMonth <= now.getTime()
      ? thisMonth
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, dayOfMonth, hour),
  );
}
