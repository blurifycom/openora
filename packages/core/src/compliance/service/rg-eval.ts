import { RG_FLAG_THRESHOLD_PCT, type LimitPeriod } from '@openora/core/contracts';

// Pure, DB-free RG evaluation helpers. Rolling windows (last N) rather than calendar
// buckets: a defensible, timezone-free reading of "daily/weekly/monthly" spend.
const PERIOD_MS: Record<Exclude<LimitPeriod, 'session'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function periodWindow(period: LimitPeriod, now: Date): { from: Date; to: Date } {
  if (period === 'session') {
    return { from: now, to: now };
  }
  return { from: new Date(now.getTime() - PERIOD_MS[period]), to: now };
}

export function thresholdPct(actual: number, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  return (actual / limit) * 100;
}

export function isAtThreshold(actual: number, limit: number): boolean {
  return thresholdPct(actual, limit) >= RG_FLAG_THRESHOLD_PCT;
}

export type PendingChangeStatus = 'waiting' | 'ready' | 'expired';

export function pendingChangeStatus(
  row: {
    pendingKind: string | null;
    pendingEffectiveAt: Date | null;
    pendingExpiresAt: Date | null;
  },
  now: Date,
): PendingChangeStatus | null {
  if (row.pendingKind === null || row.pendingEffectiveAt === null) {
    return null;
  }
  if (row.pendingExpiresAt !== null && now >= row.pendingExpiresAt) {
    return 'expired';
  }
  return now >= row.pendingEffectiveAt ? 'ready' : 'waiting';
}
