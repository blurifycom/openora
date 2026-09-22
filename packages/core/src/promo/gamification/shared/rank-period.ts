export type RankPeriodKind = 'daily' | 'weekly' | 'monthly';

export type RankPeriod = {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
  /** The grant's `sourceRef`: one payout per player per period, however often the job runs. */
  sourceRef: string;
};

const DAY_MS = 86_400_000;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

// ISO 8601: a week belongs to the year its Thursday falls in.
function isoWeek(monday: Date) {
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The last UTC period that has fully ended by `now`: yesterday, last ISO week (Monday to Monday)
 * or last calendar month. The period is fixed, whatever time the operator schedules the payout
 * for, so a job that runs twice - or at an odd hour - still pays each period once.
 */
export function lastCompletePeriod(kind: RankPeriodKind, now: Date): RankPeriod {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (kind === 'daily') {
    const start = new Date(today - DAY_MS);
    return { start, end: new Date(today), sourceRef: `rank-daily:${isoDate(start)}` };
  }
  if (kind === 'weekly') {
    const daysSinceMonday = (now.getUTCDay() + 6) % 7;
    const end = new Date(today - daysSinceMonday * DAY_MS);
    const start = new Date(end.getTime() - 7 * DAY_MS);
    return { start, end, sourceRef: `rank-weekly:${isoWeek(start)}` };
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end, sourceRef: `rank-monthly:${isoDate(start).slice(0, 7)}` };
}
