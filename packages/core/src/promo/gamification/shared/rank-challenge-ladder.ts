import { leaderboardNamesOf, type IdentityReader, type Uuid } from '@openora/core/contracts';
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

export async function withWinners<T extends Pick<PromoRankChallengeTier, 'id'>>(
  db: DrizzleDb | DrizzleTx,
  tiers: readonly T[],
) {
  const claims = await db
    .select({
      tierId: promoRankChallengeClaim.tierId,
      userId: promoRankChallengeClaim.userId,
      claimedAt: promoRankChallengeClaim.claimedAt,
    })
    .from(promoRankChallengeClaim);
  const byTier = new Map(claims.map((c) => [c.tierId, c]));
  return tiers.map((tier) => {
    const claim = byTier.get(tier.id);
    return {
      ...tier,
      winnerUserId: claim?.userId ?? null,
      claimedAt: claim ? claim.claimedAt.toISOString() : null,
    };
  });
}

export async function nameWinners<
  T extends { winnerUserId: Uuid | null; claimedAt: string | null },
>(
  identity: IdentityReader,
  tiers: readonly T[],
): Promise<(T & { winnerUsername: string | null })[]> {
  const names = await leaderboardNamesOf(
    identity,
    tiers.flatMap((tier) => (tier.winnerUserId ? [tier.winnerUserId] : [])),
  );
  return tiers.map((tier) => {
    const name = tier.winnerUserId ? names.get(tier.winnerUserId) : undefined;
    return name
      ? { ...tier, winnerUsername: name.username }
      : { ...tier, winnerUserId: null, claimedAt: null, winnerUsername: null };
  });
}

export async function withUsernames<T extends { userId: Uuid }>(
  identity: IdentityReader,
  rows: readonly T[],
): Promise<(T & { username: string })[]> {
  const names = await leaderboardNamesOf(
    identity,
    rows.map((row) => row.userId),
  );
  return rows.flatMap((row) => {
    const name = names.get(row.userId);
    return name ? [{ ...row, username: name.username }] : [];
  });
}
