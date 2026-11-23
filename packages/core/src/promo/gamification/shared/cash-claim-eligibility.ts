import { eq } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import type { PlayEligibilityPort, RgExclusionReader, Uuid } from '@openora/core/contracts';
import type { RankRewardClaimBlocker } from '../contract/index.js';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';

export const CLAIM_BLOCKED_STATUSES = ['suspended', 'closed'] as const;

export type CashClaimBlocker = RankRewardClaimBlocker;

/**
 * Why the player may not claim real cash right now, or null. Inside a claim, pass the claim's
 * transaction: the player row is then share-locked so a status change waits for the claim.
 */
export async function cashClaimBlocker(
  db: DrizzleDb | DrizzleTx,
  eligibility: PlayEligibilityPort | undefined,
  userId: Uuid,
  { lock }: { lock: boolean },
): Promise<CashClaimBlocker | null> {
  if (!eligibility) {
    return 'restricted';
  }
  // The player row before the user row: a status writer holds the player row while identity
  // republishes play eligibility, which takes the user row, so the other order deadlocks.
  const query = db.select({ status: player.status }).from(player).where(eq(player.userId, userId));
  const [account] = lock ? await query.for('share') : await query;
  if (await eligibility.isRestricted(userId, lock ? db : undefined)) {
    return 'restricted';
  }
  if (!account || account.status === 'self_excluded') {
    return 'restricted';
  }
  if ((CLAIM_BLOCKED_STATUSES as readonly string[]).includes(account.status)) {
    return 'account_blocked';
  }
  return null;
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

/** `isDueForAutoPayout` with the player row share-locked for the payout's transaction. */
export async function isDueForAutoPayoutLocked(
  tx: DrizzleTx,
  exclusions: RgExclusionReader | undefined,
  userId: Uuid,
): Promise<boolean> {
  const [account] = await tx
    .select({ status: player.status })
    .from(player)
    .where(eq(player.userId, userId))
    .for('share');
  return isDueForAutoPayout(exclusions, userId, account?.status ?? null, tx);
}
