import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  type AuditWritePort,
  type BonusForfeitHeldArgs,
  type BonusForfeitReason,
  type ClientMeta,
  type GrantConcurrencyMode,
  type PlayEligibilityPort,
  type Uuid,
} from '@openora/core/contracts';
import {
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { promoGrant, promoGrantEntry, type PromoGrant } from '../schema/index.js';
import { BonusSlotTakenError, isSlotTaken, withGrantSlotLock } from '../shared/grant-slot.js';

export const GrantNotForfeitableError = makeConflictError(
  'GrantNotForfeitableError',
  'This bonus is no longer live, so there is nothing to forfeit',
);
export const GrantNotFoundError = makeNotFoundError('Grant');
export const GrantNotActivatableError = makeConflictError(
  'GrantNotActivatableError',
  'Only a pending bonus inside its claim window can be activated',
  { code: 'BONUS_NOT_ACTIVATABLE' },
);
export const GrantActivationRestrictedError = makeConflictError(
  'GrantActivationRestrictedError',
  'Your account cannot start a bonus right now',
  { code: 'BONUS_PLAY_RESTRICTED' },
);
export const PlayerForfeitNotAllowedError = makeConflictError(
  'PlayerForfeitNotAllowedError',
  'This bonus can only be forfeited by support',
);

const PLAYER_FORFEIT_NOTE = 'Forfeited by the player';

const LIVE_STATUSES = ['pending', 'active'] as const;

const ZERO = '0';

const EXPIRY_SWEEP_BATCH = 500;

type ClosedGrant = {
  grantId: PromoGrant['id'];
  userId: Uuid;
  currency: string;
  forfeitedAmount: string;
  actorId: Uuid | null;
};

export class GrantLifecycleService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly events: EventBus,
    private readonly playEligibility: PlayEligibilityPort,
    private readonly concurrency: GrantConcurrencyMode = 'multiple',
  ) {}

  async activate({
    userId,
    grantId,
    meta,
  }: {
    userId: Uuid;
    grantId: PromoGrant['id'];
    meta?: ClientMeta | undefined;
  }): Promise<PromoGrant> {
    return this.drizzle.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ currency: promoGrant.currency })
        .from(promoGrant)
        .where(and(eq(promoGrant.id, grantId), eq(promoGrant.userId, userId)));
      if (!owned) {
        throw new GrantNotFoundError(grantId);
      }
      if (await this.playEligibility.isRestricted(userId, tx)) {
        throw new GrantActivationRestrictedError();
      }
      return withGrantSlotLock(tx, this.concurrency, userId, owned.currency, async () => {
        const [grant] = await tx
          .select({
            status: promoGrant.status,
            source: promoGrant.source,
            expiresAt: promoGrant.expiresAt,
            terms: promoGrant.terms,
            inWindow: sql<boolean>`${promoGrant.expiresAt} > now()`,
          })
          .from(promoGrant)
          .where(eq(promoGrant.id, grantId))
          .for('update');
        if (!grant || grant.status !== 'pending' || !grant.inWindow) {
          throw new GrantNotActivatableError();
        }
        if (
          await isSlotTaken(tx, this.concurrency, {
            userId,
            currency: owned.currency,
            source: grant.source,
          })
        ) {
          throw new BonusSlotTakenError();
        }
        const [activated] = await tx
          .update(promoGrant)
          .set({
            status: 'active',
            activatedAt: sql`now()`,
            expiresAt: sql`now() + make_interval(days => ${grant.terms.expiryDays})`,
          })
          .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'pending')))
          .returning();
        if (!activated) {
          throw new GrantNotActivatableError();
        }
        await this.audit.recordInTransaction(tx, {
          actorType: 'player',
          actorId: userId,
          action: 'promo.bonus.activated',
          resourceType: 'promo_grant',
          resourceId: grantId,
          before: { status: grant.status, expiresAt: grant.expiresAt.toISOString() },
          after: {
            userId,
            status: activated.status,
            expiresAt: activated.expiresAt.toISOString(),
          },
          ...meta,
        });
        await this.events.emitInTransaction(tx, 'promo.bonus.activated', {
          userId,
          grantId,
          currency: activated.currency,
          source: activated.source,
          expiresAt: activated.expiresAt.toISOString(),
        });
        return activated;
      });
    });
  }

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

  async forfeitHeld(
    tx: DrizzleTx,
    { userId, reason, actor, note, meta }: BonusForfeitHeldArgs,
  ): Promise<ClosedGrant[]> {
    const held = await tx
      .select({ id: promoGrant.id })
      .from(promoGrant)
      .where(
        and(
          eq(promoGrant.userId, userId),
          inArray(promoGrant.status, LIVE_STATUSES),
          lte(promoGrant.createdAt, sql`now()`),
        ),
      )
      .orderBy(asc(promoGrant.createdAt));

    const closed: ClosedGrant[] = [];
    for (const { id } of held) {
      const row = await this.close(tx, id, {
        status: 'forfeited',
        action: 'promo.bonus.forfeited',
        reason,
        actor,
        note,
        ...(meta === undefined ? {} : { meta }),
      });
      if (row) {
        closed.push(row);
      }
    }
    return closed;
  }

  async forfeit({
    grantId,
    reason,
    actor,
    note,
    meta,
  }: {
    grantId: PromoGrant['id'];
    reason: BonusForfeitReason;
    actor?: { id: Uuid; isAdmin: boolean } | undefined;
    note: string;
    meta?: ClientMeta | undefined;
  }): Promise<ClosedGrant> {
    const [exists] = await this.drizzle.db
      .select({ status: promoGrant.status, userId: promoGrant.userId })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    if (!exists) {
      await this.recordRefusal({ grantId, userId: null, actor, note, status: 'not_found', meta });
      throw new GrantNotFoundError(grantId);
    }

    const closed = await this.drizzle.db.transaction((tx) =>
      this.close(tx, grantId, {
        status: 'forfeited',
        action: 'promo.bonus.forfeited',
        reason,
        ...(actor === undefined ? {} : { actor }),
        note,
        ...(meta === undefined ? {} : { meta }),
      }),
    );
    if (!closed) {
      const [current] = await this.drizzle.db
        .select({ status: promoGrant.status })
        .from(promoGrant)
        .where(eq(promoGrant.id, grantId));
      await this.recordRefusal({
        grantId,
        userId: exists.userId,
        actor,
        note,
        status: current?.status ?? exists.status,
        meta,
      });
      throw new GrantNotForfeitableError();
    }
    return closed;
  }

  async forfeitByPlayer({
    userId,
    grantId,
    meta,
  }: {
    userId: Uuid;
    grantId: PromoGrant['id'];
    meta?: ClientMeta | undefined;
  }): Promise<ClosedGrant> {
    const actor = { id: userId, isAdmin: false };
    const [owned] = await this.drizzle.db
      .select({ terms: promoGrant.terms })
      .from(promoGrant)
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.userId, userId)));
    if (!owned) {
      await this.recordRefusal({
        grantId,
        userId: null,
        actor,
        note: PLAYER_FORFEIT_NOTE,
        status: 'not_found',
        meta,
      });
      throw new GrantNotFoundError(grantId);
    }
    if (owned.terms.allowPlayerForfeit !== true) {
      await this.recordRefusal({
        grantId,
        userId,
        actor,
        note: PLAYER_FORFEIT_NOTE,
        status: 'not_allowed',
        meta,
      });
      throw new PlayerForfeitNotAllowedError();
    }
    return this.forfeit({
      grantId,
      reason: 'player_opt_out',
      actor,
      note: PLAYER_FORFEIT_NOTE,
      meta,
    });
  }

  private async recordRefusal({
    grantId,
    userId,
    actor,
    note,
    status,
    meta,
  }: {
    grantId: PromoGrant['id'];
    userId: Uuid | null;
    actor: { id: Uuid; isAdmin: boolean } | undefined;
    note: string;
    status: string;
    meta: ClientMeta | undefined;
  }): Promise<void> {
    await this.audit.record({
      ...(actor === undefined
        ? { actorType: 'system' as const }
        : {
            actorId: actor.id,
            actorType: actor.isAdmin ? ('admin' as const) : ('player' as const),
          }),
      action: 'promo.bonus.forfeit_refused',
      resourceType: 'promo_grant',
      resourceId: grantId,
      after: { ...(userId === null ? {} : { userId }), status, note },
      ...meta,
    });
  }

  private async close(
    tx: DrizzleTx,
    grantId: PromoGrant['id'],
    outcome: {
      status: 'expired' | 'forfeited';
      action: 'promo.bonus.expired' | 'promo.bonus.forfeited';
      reason?: BonusForfeitReason;
      actor?: { id: Uuid; isAdmin: boolean };
      note?: string;
      meta?: ClientMeta;
    },
  ): Promise<ClosedGrant | null> {
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
        wageringProgress: ZERO,
        linkedCash: ZERO,
        unlinkedCash: ZERO,
        ...(outcome.reason === undefined ? {} : { forfeitReason: outcome.reason }),
        ...(outcome.actor === undefined ? {} : { forfeitedBy: outcome.actor.id }),
        ...(outcome.note === undefined ? {} : { forfeitNote: outcome.note }),
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
        status: locked.status,
        bonusBalance: forfeitedAmount,
        wageringProgress: locked.wageringProgress,
      },
      after: {
        userId: claimed.userId,
        status: outcome.status,
        bonusBalance: ZERO,
        forfeitedAmount,
        wageringProgress: ZERO,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.note === undefined ? {} : { note: outcome.note }),
      },
      ...outcome.meta,
    });

    const closed: ClosedGrant = {
      grantId,
      userId: claimed.userId,
      currency: claimed.currency,
      forfeitedAmount,
      actorId: outcome.actor?.isAdmin ? outcome.actor.id : null,
    };
    const { actorId, ...announced } = closed;
    if (outcome.reason === undefined) {
      await this.events.emitInTransaction(tx, 'promo.bonus.expired', announced);
    } else {
      await this.events.emitInTransaction(tx, 'promo.bonus.forfeited', {
        ...announced,
        reason: outcome.reason,
        actorId,
      });
    }
    return closed;
  }
}
