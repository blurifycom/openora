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
 * Why the player may not claim real cash right now, or null, from the ledger's play eligibility
 * projection (ADR-0056), never the identity or profile tables. Inside a claim, pass the claim's
 * transaction: the projection row is then share-locked so a restriction waits for the claim.
 * Only that row is locked: identity writes its user row before the projection, so taking the user
 * row here as well would deadlock against it.
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

/** The decision of {@link cashClaimBlocker} on a projected state; null state is no player. */
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

/**
 * The prefilter of an auto-payout sweep: the users among `userIds` whose account is closed or
 * self-excluded, or who carry an RG block, each then confirmed by {@link isDueForAutoPayout}.
 */
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

/** `isDueForAutoPayout` with the projection row share-locked for the payout's transaction. */
export async function isDueForAutoPayoutLocked(
  tx: DrizzleTx,
  ledger: LedgerPlayEligibilityPort | undefined,
  exclusions: RgExclusionReader | undefined,
  userId: Uuid,
): Promise<boolean> {
  const state = (await ledger?.stateOf(userId, tx)) ?? null;
  return isDueForAutoPayout(exclusions, userId, state?.status ?? null, tx);
}
