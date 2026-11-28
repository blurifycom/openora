import {
  RANK_PERIODIC_REWARD_KINDS,
  type RankPayoutAnchors,
  type RankPeriodicRewardKind,
} from '../contract/index.js';

export const RANK_PERIOD_KINDS = RANK_PERIODIC_REWARD_KINDS;

export type RankPeriodKind = RankPeriodicRewardKind;

export type RankPeriod = {
  start: Date;
  end: Date;
  sourceRef: string;
};

const DAY_MS = 86_400_000;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const hourKey = (date: Date) => String(date.getUTCHours()).padStart(2, '0');

const isoWeekday = (date: Date) => date.getUTCDay() || 7;

export function openPeriodKey(kind: RankPeriodKind, now: Date, anchors: RankPayoutAnchors): string {
  const start = lastCompletePeriod(kind, now, anchors).end;
  return keyFor(kind, start);
}

function keyFor(kind: RankPeriodKind, start: Date) {
  if (kind === 'daily') {
    return `rank-daily:${isoDate(start)}T${hourKey(start)}`;
  }
  return `rank-${kind}:${isoDate(start)}`;
}

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

function atHour(now: Date, hour: number) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
  return new Date(today <= now.getTime() ? today : today - DAY_MS);
}

function lastWeekdayAtHour(now: Date, weekday: number, hour: number) {
  const candidate = atHour(now, hour);
  const back = (isoWeekday(candidate) - weekday + 7) % 7;
  return new Date(candidate.getTime() - back * DAY_MS);
}

function lastMonthDayAtHour(now: Date, dayOfMonth: number, hour: number) {
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth, hour);
  return new Date(
    thisMonth <= now.getTime()
      ? thisMonth
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, dayOfMonth, hour),
  );
}
