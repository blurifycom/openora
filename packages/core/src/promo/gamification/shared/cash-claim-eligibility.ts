import type {
  LedgerPlayEligibilityPort,
  PlayEligibilityState,
  RgExclusionReader,
  Uuid,
} from '@openora/core/contracts';
import type { RankRewardClaimBlocker } from '../contract/index.js';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';

const CLAIM_BLOCKED_STATUSES = ['suspended', 'closed'] as const;

export type CashClaimBlocker = RankRewardClaimBlocker;

/**
 */
export async function cashClaimBlocker(
  db: DrizzleDb | DrizzleTx,
  ledger: LedgerPlayEligibilityPort | undefined,
  userId: Uuid,
  { lock }: { lock: boolean },
): Promise<CashClaimBlocker | null> {
  if (!ledger) {
    return 'restricted';
  }
  return claimBlockerOf(await ledger.stateOf(userId, lock ? db : undefined));
}

export function claimBlockerOf(
  state: PlayEligibilityState | null,
  now = new Date(),
): CashClaimBlocker | null {
  const rgBlocked =
    state?.rgBlocked === true && (state.rgBlockedUntil === null || state.rgBlockedUntil > now);
  if (!state || rgBlocked || state.status === null || state.status === 'self_excluded') {
    return 'restricted';
  }
  if ((CLAIM_BLOCKED_STATUSES as readonly string[]).includes(state.status)) {
    return 'account_blocked';
  }
  return null;
}

export async function autoPayoutCandidates(
  ledger: LedgerPlayEligibilityPort | undefined,
  userIds: readonly Uuid[],
): Promise<{ userId: Uuid; status: string | null }[]> {
  const states = (await ledger?.statesOf(userIds)) ?? new Map<Uuid, PlayEligibilityState>();
  return userIds.flatMap((userId) => {
    const state = states.get(userId);
    return state &&
      (state.rgBlocked || state.status === 'closed' || state.status === 'self_excluded')
      ? [{ userId, status: state.status }]
      : [];
  });
}

/**
 * Whether a player's unclaimed cash is paid without a claim: a closed account or a
 * self-exclusion. An RG block is also a cooling-off, which keeps the cash for the player to claim
 * later.
 */
export async function isDueForAutoPayout(
  exclusions: RgExclusionReader | undefined,
  userId: Uuid,
  status: string | null,
  tx?: DrizzleTx,
): Promise<boolean> {
  if (status === 'closed' || status === 'self_excluded') {
    return true;
  }
  const state = await exclusions?.getExclusionState(userId, tx);
  return state?.isSelfExcluded === true;
}

export async function isDueForAutoPayoutLocked(
  tx: DrizzleTx,
  ledger: LedgerPlayEligibilityPort | undefined,
  exclusions: RgExclusionReader | undefined,
  userId: Uuid,
): Promise<boolean> {
  const exclusion = await exclusions?.getExclusionState(userId, tx);
  const state = (await ledger?.stateOf(userId, tx)) ?? null;
  return (
    state?.status === 'closed' ||
    state?.status === 'self_excluded' ||
    exclusion?.isSelfExcluded === true
  );
}
