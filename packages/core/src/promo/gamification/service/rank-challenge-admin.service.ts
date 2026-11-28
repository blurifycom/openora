import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AuditWritePort, IdentityReader, Uuid } from '@openora/core/contracts';
import {
  createDomainError,
  withAdvisoryXactLock,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type {
  RankChallengeAdminLadder,
  RankChallengeClaim,
  SetRankChallengeLadderInput,
} from '../contract/index.js';
import { promoRankChallengeClaim, promoRankChallengeTier } from '../schema/index.js';
import {
  nameWinners,
  TIER_COLUMNS,
  withUsernames,
  withWinners,
} from '../shared/rank-challenge-ladder.js';

export const RankChallengeLadderCurrencyHeldError = createDomainError(
  'RankChallengeLadderCurrencyHeldError',
  () => 'the ladder currency cannot change once a player has wagered toward it',
);

export const RankChallengeLadderVersionConflictError = createDomainError(
  'RankChallengeLadderVersionConflictError',
  () => 'the ladder changed since it was loaded; reload it and apply the edit again',
  { reason: 'stale_version' },
);

const LADDER_LOCK_KEY = 'promo_rank_challenge_ladder';

export const ladderVersion = (rows: readonly object[]) =>
  createHash('sha256').update(JSON.stringify(rows)).digest('hex');

type UnnamedLadder = Omit<RankChallengeAdminLadder, 'tiers'> & {
  tiers: Omit<RankChallengeAdminLadder['tiers'][number], 'winnerUsername'>[];
};

async function toLadder(tx: DrizzleTx, fallbackCurrency: string): Promise<UnnamedLadder> {
  const rows = await tx
    .select({ ...TIER_COLUMNS, currency: promoRankChallengeTier.currency })
    .from(promoRankChallengeTier)
    .orderBy(asc(promoRankChallengeTier.position), asc(promoRankChallengeTier.id));
  return {
    currency: rows[0]?.currency ?? fallbackCurrency,
    version: ladderVersion(rows),
    tiers: await withWinners(
      tx,
      rows.map(({ currency: _currency, ...tier }) => tier),
    ),
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

const claimsQuery = (db: DrizzleDb | DrizzleTx) =>
  db
    .select({
      tierId: promoRankChallengeClaim.tierId,
      tierKey: promoRankChallengeTier.key,
      userId: promoRankChallengeClaim.userId,
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
    );

export class RankChallengeAdminService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly identity: IdentityReader,
  ) {}

  async getLadder(): Promise<RankChallengeAdminLadder> {
    return this.named(await this.drizzle.db.transaction((tx) => toLadder(tx, 'USD')));
  }

  async setLadder(
    adminId: Uuid,
    input: SetRankChallengeLadderInput,
  ): Promise<RankChallengeAdminLadder> {
    return this.named(
      await this.drizzle.db.transaction((tx) =>
        withAdvisoryXactLock(tx, LADDER_LOCK_KEY, () => this.replaceLadder(tx, adminId, input)),
      ),
    );
  }

  private async named(ladder: UnnamedLadder): Promise<RankChallengeAdminLadder> {
    return { ...ladder, tiers: await nameWinners(this.identity, ladder.tiers) };
  }

  private async replaceLadder(
    tx: DrizzleTx,
    adminId: Uuid,
    input: SetRankChallengeLadderInput,
  ): Promise<UnnamedLadder> {
    const before = await toLadder(tx, input.currency);
    if (before.version !== input.version) {
      throw new RankChallengeLadderVersionConflictError();
    }
    if (before.tiers.length > 0 && before.currency !== input.currency) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(promoRankChallengeClaim);
      if ((count ?? 0) > 0) {
        throw new RankChallengeLadderCurrencyHeldError();
      }
    }

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
  }

  async listClaims(): Promise<RankChallengeClaim[]> {
    const rows = await claimsQuery(this.drizzle.db).orderBy(
      desc(promoRankChallengeClaim.claimedAt),
    );
    return (await withUsernames(this.identity, rows)).map(toClaim);
  }

  async listFulfilmentQueue(): Promise<RankChallengeClaim[]> {
    const rows = await claimsQuery(this.drizzle.db)
      .where(
        and(
          isNotNull(promoRankChallengeClaim.physicalItem),
          isNull(promoRankChallengeClaim.physicalFulfilledAt),
        ),
      )
      .orderBy(desc(promoRankChallengeClaim.claimedAt));
    return (await withUsernames(this.identity, rows)).map(toClaim);
  }

  async markFulfilled(adminId: Uuid, tierId: Uuid, note: string): Promise<RankChallengeClaim> {
    const row = await this.drizzle.db.transaction(async (tx) => {
      const [claim] = await tx
        .select()
        .from(promoRankChallengeClaim)
        .where(eq(promoRankChallengeClaim.tierId, tierId))
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
        .where(eq(promoRankChallengeClaim.tierId, tierId));
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rankChallenge.fulfilled',
        resourceType: 'promo_rank_challenge_claim',
        resourceId: tierId,
        before: { physicalFulfilledAt: null },
        after: { physicalFulfilledAt: new Date().toISOString(), note },
      });
      const [row] = await claimsQuery(tx).where(eq(promoRankChallengeClaim.tierId, tierId));
      if (!row) {
        throw new Error('rank challenge claim vanished after update');
      }
      return row;
    });
    const [named] = await withUsernames(this.identity, [row]);
    if (!named) {
      throw new Error('rank challenge claim winner is unknown to identity');
    }
    return toClaim(named);
  }
}
