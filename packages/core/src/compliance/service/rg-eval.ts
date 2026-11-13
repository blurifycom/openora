import { RG_FLAG_THRESHOLD_PCT } from '@openora/core/contracts';

// Pure, DB-free RG evaluation helpers.

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
