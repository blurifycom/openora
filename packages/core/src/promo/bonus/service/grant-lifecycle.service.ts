import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { type AuditWritePort, type BonusForfeitReason, type Uuid } from '@openora/core/contracts';
import {
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import { promoGrant, promoGrantEntry, type PromoGrant } from '../schema/index.js';

export const GrantNotForfeitableError = makeConflictError(
  'GrantNotForfeitableError',
  'This bonus is no longer live, so there is nothing to forfeit',
);
export const GrantNotFoundError = makeNotFoundError('Grant');

/** A grant that can still be taken away. `completed`, `expired` and `forfeited` cannot. */
const LIVE_STATUSES = ['pending', 'active'] as const;

const ZERO = '0';

/** One sweep takes at most this many grants, oldest expiry first, so a backlog cannot starve. */
const EXPIRY_SWEEP_BATCH = 500;

type ClosedGrant = {
  grantId: PromoGrant['id'];
  userId: Uuid;
  currency: string;
  forfeitedAmount: string;
  /** The admin who forfeited it, for the `promo.bonus.forfeited` event; null otherwise. */
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
      .where(and(inArray(promoGrant.status, LIVE_STATUSES), lte(promoGrant.expiresAt, sql`now()`)))
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
      .where(and(eq(promoGrant.userId, userId), inArray(promoGrant.status, LIVE_STATUSES)))
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
   * A single grant, taken away by name rather than by player - the shape a scheduled job needs
   * (an Activity Bonus grant that missed its daily wager) that `forfeitAllFor` cannot give it,
   * since that sweeps every live grant a player holds. `actor` is optional for the same reason
   * `close` already allows it: a job has no admin session to assert, and recording one it does
   * not have would misname the regulator-facing audit row as an admin action.
   */
  async forfeit(
    grantId: PromoGrant['id'],
    reason: BonusForfeitReason,
    actor: { id: Uuid; isAdmin: boolean } | undefined,
    note: string,
  ): Promise<ClosedGrant> {
    const [exists] = await this.drizzle.db
      .select({ status: promoGrant.status })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    if (!exists) {
      await this.recordRefusal(grantId, actor, note, 'not_found');
      throw new GrantNotFoundError(grantId);
    }

    const closed = await this.drizzle.db.transaction((tx) =>
      this.close(tx, grantId, {
        status: 'forfeited',
        action: 'promo.bonus.forfeited',
        reason,
        ...(actor === undefined ? {} : { actor }),
        note,
      }),
    );
    if (!closed) {
      // Not the status from the read above: expiry, a conversion, or another forfeit can close
      // the grant between that read and the claim just failing, and this refusal is itself an
      // immutable audit row. Read what the grant actually is now, not what it was on the way in.
      const [current] = await this.drizzle.db
        .select({ status: promoGrant.status })
        .from(promoGrant)
        .where(eq(promoGrant.id, grantId));
      await this.recordRefusal(grantId, actor, note, current?.status ?? exists.status);
      throw new GrantNotForfeitableError();
    }
    return closed;
  }

  /**
   * An attempt that took nothing is still an attempt on a money resource, and the record has to
   * tell a probe apart from a forfeit that landed.
   */
  private async recordRefusal(
    grantId: PromoGrant['id'],
    actor: { id: Uuid; isAdmin: boolean } | undefined,
    note: string,
    status: string,
  ): Promise<void> {
    await this.audit.record({
      ...(actor === undefined
        ? { actorType: 'system' as const }
        : {
            actorId: actor.id,
            actorType: actor.isAdmin ? ('admin' as const) : ('player' as const),
          }),
      // Its own action, not the successful one. A denial shares the resource type, so counting
      // forfeitures - or reading a grant's history in a dispute - would otherwise mix probes at
      // ids that do not exist in with the movements that destroyed real money.
      action: 'promo.bonus.forfeit_refused',
      resourceType: 'promo_grant',
      resourceId: grantId,
      after: { status, note },
    });
  }

  /**
   * Claim-then-act: the predicate on the update is what makes a second sweep, or an admin racing
   * the sweep, a no-op rather than a second ledger entry.
   */
  private async close(
    tx: DrizzleTx,
    grantId: PromoGrant['id'],
    outcome: {
      status: 'expired' | 'forfeited';
      action: 'promo.bonus.expired' | 'promo.bonus.forfeited';
      reason?: BonusForfeitReason;
      actor?: { id: Uuid; isAdmin: boolean };
      note?: string;
    },
  ): Promise<ClosedGrant | null> {
    // The balance under the lock the update is about to take, so the amount recorded as
    // forfeited is the column the CHECK constraint protects rather than a derived sum.
    const [locked] = await tx
      .select({
        status: promoGrant.status,
        bonusBalance: promoGrant.bonusBalance,
        wageringProgress: promoGrant.wageringProgress,
      })
      .from(promoGrant)
      .where(and(eq(promoGrant.id, grantId), inArray(promoGrant.status, LIVE_STATUSES)))
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
      .where(and(eq(promoGrant.id, grantId), inArray(promoGrant.status, LIVE_STATUSES)))
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
      // From the locked read, not the update's RETURNING: Postgres returns the new row there, so
      // the audit row would have said the grant was already forfeited before it was forfeited.
      before: {
        status: locked.status,
        bonusBalance: forfeitedAmount,
        wageringProgress: locked.wageringProgress,
      },
      after: {
        status: outcome.status,
        bonusBalance: ZERO,
        forfeitedAmount,
        wageringProgress: ZERO,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.note === undefined ? {} : { note: outcome.note }),
      },
    });

    return {
      grantId,
      userId: claimed.userId,
      currency: claimed.currency,
      forfeitedAmount,
      // The event's actorId names the admin who forfeited it, null otherwise - a player's own
      // id here would tell downstream consumers an admin forfeited their own self-exclusion.
      actorId: outcome.actor?.isAdmin ? outcome.actor.id : null,
    };
  }
}
