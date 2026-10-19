import { eq } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import {
  promoRankChallengeClaim,
  promoRankChallengeTier,
  type PromoRankChallengeTier,
} from '../schema/index.js';

export const TIER_COLUMNS = {
  id: promoRankChallengeTier.id,
  key: promoRankChallengeTier.key,
  name: promoRankChallengeTier.name,
  position: promoRankChallengeTier.position,
  wagerThreshold: promoRankChallengeTier.wagerThreshold,
  cashAmount: promoRankChallengeTier.cashAmount,
  physicalItem: promoRankChallengeTier.physicalItem,
};

/** Each tier with who has won it so far, or nulls while it is still open. */
export async function withWinners<T extends Pick<PromoRankChallengeTier, 'id'>>(
  db: DrizzleDb | DrizzleTx,
  tiers: readonly T[],
) {
  const claims = await db
    .select({
      tierId: promoRankChallengeClaim.tierId,
      userId: promoRankChallengeClaim.userId,
      username: user.username,
      claimedAt: promoRankChallengeClaim.claimedAt,
    })
    .from(promoRankChallengeClaim)
    .innerJoin(user, eq(user.id, promoRankChallengeClaim.userId));
  const byTier = new Map(claims.map((c) => [c.tierId, c]));
  return tiers.map((tier) => {
    const claim = byTier.get(tier.id);
    return {
      ...tier,
      winnerUserId: claim?.userId ?? null,
      winnerUsername: claim?.username ?? null,
      claimedAt: claim ? claim.claimedAt.toISOString() : null,
    };
  });
}
