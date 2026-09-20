import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { type AuditWritePort, type BonusForfeitReason, type Uuid } from '@openora/core/contracts';
import { moneyCompare, type DrizzleService, type DrizzleTx } from '@openora/core/server';
import { promoGrant, promoGrantEntry, type PromoGrant } from '../schema/index.js';

const ZERO = '0';

/** One sweep takes at most this many grants, oldest expiry first, so a backlog cannot starve. */
const EXPIRY_SWEEP_BATCH = 500;

type ClosedGrant = {
  grantId: PromoGrant['id'];
  userId: Uuid;
  currency: string;
  forfeitedAmount: string;
  actorId: Uuid | null;
};

/**
 * What ends a grant: its expiry, or someone taking it away. Both leave the same shape behind -
 * a terminal status, a zeroed bonus balance, a ledger entry for the funds that died with it,
 * and an audit row - so they are one code path with two reasons.
 *
 * Unlike the wagering engine this owns its transactions: nothing else is moving money at the
 * same time, and a sweep that took the caller's transaction would hold it open across the batch.
 */
export class GrantLifecycleService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  /**
   * Expire what is due. Each grant is claimed and closed in its own transaction, so a second
   * sweep running beside this one settles on a row rather than duplicating its ledger entry.
   */
  async expireDue(): Promise<ClosedGrant[]> {
    const due = await this.drizzle.db
      .select({ id: promoGrant.id })
      .from(promoGrant)
      .where(and(eq(promoGrant.status, 'active'), lte(promoGrant.expiresAt, sql`now()`)))
      .orderBy(asc(promoGrant.expiresAt))
      .limit(EXPIRY_SWEEP_BATCH);

    const closed: ClosedGrant[] = [];
    for (const { id } of due) {
      const row = await this.drizzle.db.transaction((tx) =>
        this.close(tx, id, { status: 'expired', action: 'promo.bonus.expired' }),
      );
      if (row) {
        closed.push(row);
      }
    }
    return closed;
  }

  /** Every live grant a player holds, taken away at once - a self-exclusion, a closed account. */
  async forfeitAllFor(
    userId: Uuid,
    reason: BonusForfeitReason,
    actor?: { id: Uuid; isAdmin: boolean },
  ): Promise<ClosedGrant[]> {
    const live = await this.drizzle.db
      .select({ id: promoGrant.id })
      .from(promoGrant)
      .where(and(eq(promoGrant.userId, userId), eq(promoGrant.status, 'active')))
      .orderBy(asc(promoGrant.createdAt));

    const closed: ClosedGrant[] = [];
    for (const { id } of live) {
      const row = await this.drizzle.db.transaction((tx) =>
        this.close(tx, id, {
          status: 'forfeited',
          action: 'promo.bonus.forfeited',
          reason,
          ...(actor === undefined ? {} : { actor }),
        }),
      );
      if (row) {
        closed.push(row);
      }
    }
    return closed;
  }

  /**
   * Claim-then-act: the `status = 'active'` predicate on the update is what makes a second
   * sweep, or an admin racing the sweep, a no-op rather than a second ledger entry.
   */
  private async close(
    tx: DrizzleTx,
    grantId: PromoGrant['id'],
    outcome: {
      status: 'expired' | 'forfeited';
      action: 'promo.bonus.expired' | 'promo.bonus.forfeited';
      reason?: BonusForfeitReason;
      actor?: { id: Uuid; isAdmin: boolean };
    },
  ): Promise<ClosedGrant | null> {
    // The balance under the lock the update is about to take, so the amount recorded as
    // forfeited is the column the CHECK constraint protects rather than a derived sum.
    const [locked] = await tx
      .select({
        bonusBalance: promoGrant.bonusBalance,
        wageringProgress: promoGrant.wageringProgress,
      })
      .from(promoGrant)
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .for('update');
    if (!locked) {
      return null;
    }

    const [claimed] = await tx
      .update(promoGrant)
      .set({
        status: outcome.status,
        closedAt: sql`now()`,
        bonusBalance: ZERO,
        // The requirement dies with the funds. A terminal grant still reporting progress reads,
        // on the backoffice screen the rule is written for, as a bonus part-way to converting.
        wageringProgress: ZERO,
        ...(outcome.reason === undefined ? {} : { forfeitReason: outcome.reason }),
      })
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({
        userId: promoGrant.userId,
        currency: promoGrant.currency,
        grantedAmount: promoGrant.grantedAmount,
      });
    if (!claimed) {
      return null;
    }

    const forfeitedAmount = locked.bonusBalance;

    if (moneyCompare(forfeitedAmount, ZERO) > 0) {
      await tx.insert(promoGrantEntry).values({
        grantId,
        userId: claimed.userId,
        currency: claimed.currency,
        type: outcome.status === 'expired' ? 'expire' : 'forfeit',
        bonusAmount: `-${forfeitedAmount}`,
        balanceAfter: ZERO,
      });
    }

    await this.audit.recordInTransaction(tx, {
      // A player excluding themselves is not an admin action, and recording it as one would
      // put the wrong name against a forfeiture in the regulator-facing record.
      ...(outcome.actor === undefined
        ? { actorType: 'system' as const }
        : {
            actorType: outcome.actor.isAdmin ? ('admin' as const) : ('player' as const),
            actorId: outcome.actor.id,
          }),
      action: outcome.action,
      resourceType: 'promo_grant',
      resourceId: grantId,
      before: {
        status: 'active',
        bonusBalance: forfeitedAmount,
        wageringProgress: locked.wageringProgress,
      },
      after: {
        status: outcome.status,
        bonusBalance: ZERO,
        forfeitedAmount,
        wageringProgress: ZERO,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      },
    });

    return {
      grantId,
      userId: claimed.userId,
      currency: claimed.currency,
      forfeitedAmount,
      actorId: outcome.actor?.id ?? null,
    };
  }
}
