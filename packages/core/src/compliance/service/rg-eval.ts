import type { LimitPeriod } from '@openora/core/contracts';

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

// The 80% monitoring band per the Confluence spec.
export const RG_FLAG_THRESHOLD_PCT = 80;

export function isAtThreshold(actual: number, limit: number): boolean {
  return thresholdPct(actual, limit) >= RG_FLAG_THRESHOLD_PCT;
}

/**
 * Where a parked limit-change request stands right now. The one reader of the
 * `pending*` columns' timestamps, so the API, the UI and the confirm handler can never
 * disagree about whether a request may be confirmed.
 *
 * `expired` is derived, not stored: the sweep that clears lapsed requests runs on a
 * timer, so a request can be past `pendingExpiresAt` and still sitting in the row. This
 * function reports it as expired anyway, which is what makes the confirm path refuse it
 * without depending on the sweep having run. Callers on the wire surface report an
 * expired request as no request at all (`null`) - the client never learns the state.
 */
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
  // Expiry is checked BEFORE readiness: a request that sat unconfirmed past its window
  // is gone, however long ago it became confirmable.
  if (row.pendingExpiresAt !== null && now >= row.pendingExpiresAt) {
    return 'expired';
  }
  return now >= row.pendingEffectiveAt ? 'ready' : 'waiting';
}
