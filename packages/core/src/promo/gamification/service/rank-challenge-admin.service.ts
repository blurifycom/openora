import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type { AuditWritePort, Uuid } from '@openora/core/contracts';
import { createDomainError, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import type {
  RankChallengeClaim,
  RankChallengeLadder,
  SetRankChallengeLadderInput,
} from '../contract/index.js';
import { promoRankChallengeClaim, promoRankChallengeTier } from '../schema/index.js';

export const RankChallengeLadderCurrencyHeldError = createDomainError(
  'RankChallengeLadderCurrencyHeldError',
  () => 'the ladder currency cannot change once a player has wagered toward it',
);

const TIER_COLUMNS = {
  id: promoRankChallengeTier.id,
  key: promoRankChallengeTier.key,
  name: promoRankChallengeTier.name,
  position: promoRankChallengeTier.position,
  wagerThreshold: promoRankChallengeTier.wagerThreshold,
  cashAmount: promoRankChallengeTier.cashAmount,
  physicalItem: promoRankChallengeTier.physicalItem,
};

async function toLadder(tx: DrizzleTx, currency: string): Promise<RankChallengeLadder> {
  const tiers = await tx
    .select(TIER_COLUMNS)
    .from(promoRankChallengeTier)
    .orderBy(asc(promoRankChallengeTier.position));
  const claims = await tx
    .select({
      tierId: promoRankChallengeClaim.tierId,
      userId: promoRankChallengeClaim.userId,
      username: user.username,
      claimedAt: promoRankChallengeClaim.claimedAt,
    })
    .from(promoRankChallengeClaim)
    .innerJoin(user, eq(user.id, promoRankChallengeClaim.userId));
  const byTier = new Map(claims.map((c) => [c.tierId, c]));
  return {
    currency,
    tiers: tiers.map((tier) => {
      const claim = byTier.get(tier.id);
      return {
        ...tier,
        winnerUserId: claim?.userId ?? null,
        winnerUsername: claim?.username ?? null,
        claimedAt: claim ? claim.claimedAt.toISOString() : null,
      };
    }),
  };
}

const toClaim = (row: {
  tierId: Uuid;
  tierKey: string;
  userId: Uuid;
  username: string;
  cashAmount: string | null;
  physicalItem: string | null;
  claimedAt: Date;
  physicalFulfilledAt: Date | null;
  physicalFulfillmentNote: string | null;
}): RankChallengeClaim => ({
  tierId: row.tierId,
  tierKey: row.tierKey,
  userId: row.userId,
  username: row.username,
  cashAmount: row.cashAmount,
  physicalItem: row.physicalItem,
  claimedAt: row.claimedAt.toISOString(),
  physicalFulfilledAt: row.physicalFulfilledAt ? row.physicalFulfilledAt.toISOString() : null,
  physicalFulfillmentNote: row.physicalFulfillmentNote,
});

/**
 * The operator's side of the Rank Challenge: read/replace the ladder, list winner records, and
 * run the physical-prize fulfilment queue. Prospective by construction - a claim snapshots its
 * own `cashAmount`/`physicalItem` at the moment it is won, so editing or even removing a tier's
 * config afterward can never change what a past winner was granted (see `promoRankChallengeClaim`
 * in schema/index.ts). No "held" guard like `RankAdminService`'s tier-removal check is needed for
 * that reason; the only thing still enforced is the ladder-currency lock once anyone has wagered,
 * the same rule `RankAdminService.set` applies.
 */
export class RankChallengeAdminService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async getLadder(): Promise<RankChallengeLadder> {
    return this.drizzle.db.transaction((tx) =>
      toLadder(tx, 'USD').then(async (ladder) => {
        const [row] = await tx
          .select({ currency: promoRankChallengeTier.currency })
          .from(promoRankChallengeTier)
          .limit(1);
        return { ...ladder, currency: row?.currency ?? ladder.currency };
      }),
    );
  }

  async setLadder(adminId: Uuid, input: SetRankChallengeLadderInput): Promise<RankChallengeLadder> {
    return this.drizzle.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ currency: promoRankChallengeTier.currency })
        .from(promoRankChallengeTier)
        .limit(1);
      if (existing && existing.currency !== input.currency) {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(promoRankChallengeClaim);
        if ((count ?? 0) > 0) {
          throw new RankChallengeLadderCurrencyHeldError();
        }
      }

      const before = await toLadder(tx, existing?.currency ?? input.currency);

      const kept = new Set(input.tiers.flatMap((t) => (t.id === undefined ? [] : [t.id])));
      const currentIds = before.tiers.map((t) => t.id);
      const removed = currentIds.filter((id) => !kept.has(id));
      if (removed.length > 0) {
        await tx.delete(promoRankChallengeTier).where(inArray(promoRankChallengeTier.id, removed));
      }

      for (const tier of input.tiers) {
        if (tier.id === undefined) {
          await tx.insert(promoRankChallengeTier).values({
            key: tier.key,
            name: tier.name,
            position: tier.position,
            currency: input.currency,
            wagerThreshold: tier.wagerThreshold,
            cashAmount: tier.cashAmount,
            physicalItem: tier.physicalItem,
          });
        } else {
          await tx
            .update(promoRankChallengeTier)
            .set({
              key: tier.key,
              name: tier.name,
              position: tier.position,
              currency: input.currency,
              wagerThreshold: tier.wagerThreshold,
              cashAmount: tier.cashAmount,
              physicalItem: tier.physicalItem,
            })
            .where(eq(promoRankChallengeTier.id, tier.id));
        }
      }

      const after = await toLadder(tx, input.currency);
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rankChallenge.ladder.updated',
        resourceType: 'promo_rank_challenge_tier',
        resourceId: adminId,
        before,
        after,
      });
      return after;
    });
  }

  async listClaims(): Promise<RankChallengeClaim[]> {
    const rows = await this.drizzle.db
      .select({
        tierId: promoRankChallengeClaim.tierId,
        tierKey: promoRankChallengeTier.key,
        userId: promoRankChallengeClaim.userId,
        username: user.username,
        cashAmount: promoRankChallengeClaim.cashAmount,
        physicalItem: promoRankChallengeClaim.physicalItem,
        claimedAt: promoRankChallengeClaim.claimedAt,
        physicalFulfilledAt: promoRankChallengeClaim.physicalFulfilledAt,
        physicalFulfillmentNote: promoRankChallengeClaim.physicalFulfillmentNote,
      })
      .from(promoRankChallengeClaim)
      .innerJoin(
        promoRankChallengeTier,
        eq(promoRankChallengeTier.id, promoRankChallengeClaim.tierId),
      )
      .innerJoin(user, eq(user.id, promoRankChallengeClaim.userId))
      .orderBy(desc(promoRankChallengeClaim.claimedAt));
    return rows.map(toClaim);
  }

  async listFulfilmentQueue(): Promise<RankChallengeClaim[]> {
    const rows = await this.drizzle.db
      .select({
        tierId: promoRankChallengeClaim.tierId,
        tierKey: promoRankChallengeTier.key,
        userId: promoRankChallengeClaim.userId,
        username: user.username,
        cashAmount: promoRankChallengeClaim.cashAmount,
        physicalItem: promoRankChallengeClaim.physicalItem,
        claimedAt: promoRankChallengeClaim.claimedAt,
        physicalFulfilledAt: promoRankChallengeClaim.physicalFulfilledAt,
        physicalFulfillmentNote: promoRankChallengeClaim.physicalFulfillmentNote,
      })
      .from(promoRankChallengeClaim)
      .innerJoin(
        promoRankChallengeTier,
        eq(promoRankChallengeTier.id, promoRankChallengeClaim.tierId),
      )
      .innerJoin(user, eq(user.id, promoRankChallengeClaim.userId))
      .where(
        and(
          isNotNull(promoRankChallengeClaim.physicalItem),
          isNull(promoRankChallengeClaim.physicalFulfilledAt),
        ),
      )
      .orderBy(desc(promoRankChallengeClaim.claimedAt));
    return rows.map(toClaim);
  }

  async markFulfilled(adminId: Uuid, claimId: Uuid, note: string): Promise<RankChallengeClaim> {
    return this.drizzle.db.transaction(async (tx) => {
      const [claim] = await tx
        .select()
        .from(promoRankChallengeClaim)
        .where(eq(promoRankChallengeClaim.id, claimId))
        .for('update');
      if (!claim) {
        throw new Error('rank challenge claim not found');
      }
      await tx
        .update(promoRankChallengeClaim)
        .set({
          physicalFulfilledAt: sql`now()`,
          physicalFulfilledBy: adminId,
          physicalFulfillmentNote: note,
        })
        .where(eq(promoRankChallengeClaim.id, claimId));
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rankChallenge.fulfilled',
        resourceType: 'promo_rank_challenge_claim',
        resourceId: claimId,
        before: { physicalFulfilledAt: null },
        after: { physicalFulfilledAt: new Date().toISOString(), note },
      });
      const [row] = await tx
        .select({
          tierId: promoRankChallengeClaim.tierId,
          tierKey: promoRankChallengeTier.key,
          userId: promoRankChallengeClaim.userId,
          username: user.username,
          cashAmount: promoRankChallengeClaim.cashAmount,
          physicalItem: promoRankChallengeClaim.physicalItem,
          claimedAt: promoRankChallengeClaim.claimedAt,
          physicalFulfilledAt: promoRankChallengeClaim.physicalFulfilledAt,
          physicalFulfillmentNote: promoRankChallengeClaim.physicalFulfillmentNote,
        })
        .from(promoRankChallengeClaim)
        .innerJoin(
          promoRankChallengeTier,
          eq(promoRankChallengeTier.id, promoRankChallengeClaim.tierId),
        )
        .innerJoin(user, eq(user.id, promoRankChallengeClaim.userId))
        .where(eq(promoRankChallengeClaim.id, claimId));
      if (!row) {
        throw new Error('rank challenge claim vanished after update');
      }
      return toClaim(row);
    });
  }
}
