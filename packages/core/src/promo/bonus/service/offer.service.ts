import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  type AuditWritePort,
  type BonusGrantCommands,
  type PageQuery,
  type Uuid,
  type WalletReader,
} from '@openora/core/contracts';
import {
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  moneyAdd,
  moneyCompare,
  pageToOffset,
  serializeRow,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type {
  CreatePromoOfferInput,
  PlayerOffer,
  PromoOffer,
  UpdatePromoOfferInput,
} from '../contract/index.js';
import {
  promoOffer,
  promoOptIn,
  promoOptInDeposit,
  type PromoOffer as PromoOfferRow,
  type PromoOptIn as PromoOptInRow,
} from '../schema/index.js';
import { grantAmountFor } from '../shared/grant-amount.js';
import { offerIneligibility } from '../shared/offer-eligibility.js';

export const OfferNotFoundError = makeNotFoundError('Offer');
export const OfferKeyTakenError = makeConflictError(
  'OfferKeyTakenError',
  'An offer with this key already exists',
);
export const OfferNotEligibleError = makeConflictError(
  'OfferNotEligibleError',
  'This offer is not open to you',
);
export const OfferClaimedError = makeConflictError(
  'OfferClaimedError',
  'This offer cannot be re-denominated while players hold claims on it',
);

const DATE_FIELDS = ['validFrom', 'validUntil', 'createdAt', 'updatedAt'] as const;
const MONEY_FIELDS = ['matchPercent', 'maxGrantAmount', 'minDeposit'] as const;

type OfferContext = { isFirstDeposit?: boolean };

export class OfferService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly grants: BonusGrantCommands,
    private readonly wallet: WalletReader,
    private readonly logger: { error: (context: object, message: string) => void },
  ) {}

  async listForAdmin(query: PageQuery & { status?: PromoOffer['status'] }): Promise<PromoOffer[]> {
    const rows = await this.drizzle.db
      .select()
      .from(promoOffer)
      .where(query.status === undefined ? undefined : eq(promoOffer.status, query.status))
      .orderBy(desc(promoOffer.createdAt))
      .limit(query.limit)
      .offset(pageToOffset(query.page, query.limit));
    return rows.map(toOffer);
  }

  async create(adminId: Uuid, input: CreatePromoOfferInput): Promise<PromoOffer> {
    return this.drizzle.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(promoOffer)
        .values({
          key: input.key,
          name: input.name,
          status: input.status,
          currency: input.currency,
          matchPercent: input.matchPercent,
          maxGrantAmount: input.maxGrantAmount,
          minDeposit: input.minDeposit,
          terms: input.terms,
          rules: input.rules,
          requiresOptIn: input.requiresOptIn,
          ...toPatch({ validFrom: input.validFrom, validUntil: input.validUntil }),
        })
        .onConflictDoNothing({ target: promoOffer.key })
        .returning();
      const created = findOneOrThrow(inserted, new OfferKeyTakenError());
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.offer.created',
        resourceType: 'promo_offer',
        resourceId: created.id,
        after: toOffer(created),
      });
      return toOffer(created);
    });
  }

  async update(adminId: Uuid, input: UpdatePromoOfferInput): Promise<PromoOffer> {
    const { id, ...patch } = input;
    return this.drizzle.db.transaction(async (tx) => {
      const before = await this.requireOffer(tx, id);
      // Re-denominating an offer players have already banked deposits against would pay a grant
      // in one currency backed by deposits made in another.
      if (patch.currency !== undefined && patch.currency !== before.currency) {
        const [claimed] = await tx
          .select({ id: promoOptIn.id })
          .from(promoOptIn)
          .where(eq(promoOptIn.offerId, id))
          .limit(1);
        if (claimed) {
          throw new OfferClaimedError();
        }
      }
      const [updated] = await tx
        .update(promoOffer)
        .set(toPatch(patch))
        .where(eq(promoOffer.id, id))
        .returning();
      const after = toOffer(findOneOrThrow(updated ? [updated] : [], new OfferNotFoundError(id)));
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.offer.updated',
        resourceType: 'promo_offer',
        resourceId: id,
        before: toOffer(before),
        after,
      });
      return after;
    });
  }

  /** The offers open to this player right now, with what their deposits have put toward each. */
  async listForPlayer(userId: Uuid, context: OfferContext = {}): Promise<PlayerOffer[]> {
    const rows = await this.drizzle.db
      .select({ offer: promoOffer, optIn: promoOptIn })
      .from(promoOffer)
      .leftJoin(
        promoOptIn,
        and(eq(promoOptIn.offerId, promoOffer.id), eq(promoOptIn.userId, userId)),
      )
      .where(eq(promoOffer.status, 'active'))
      .orderBy(asc(promoOffer.minDeposit));

    const at = new Date();
    return rows
      .filter(({ offer }) => offerIneligibility({ offer: toOffer(offer), at, ...context }) === null)
      .map(({ offer, optIn }) =>
        toPlayerOffer(offer, optIn?.accumulatedDeposit ?? '0', optIn !== null),
      );
  }

  async optIn(userId: Uuid, offerId: Uuid, context: OfferContext = {}): Promise<PlayerOffer> {
    return this.drizzle.db.transaction(async (tx) => {
      const offer = await this.requireOffer(tx, offerId);
      const refusal = offerIneligibility({ offer: toOffer(offer), at: new Date(), ...context });
      if (refusal !== null) {
        throw new OfferNotEligibleError();
      }
      // The unique index is the guard: two parallel opt-ins settle on one row rather than both
      // reading "not opted in" and both inserting.
      const [claimed] = await tx
        .insert(promoOptIn)
        .values({ userId, offerId })
        .onConflictDoNothing()
        .returning({ id: promoOptIn.id });
      if (claimed) {
        await this.audit.recordInTransaction(tx, {
          actorId: userId,
          actorType: 'player',
          action: 'promo.offer.claimed',
          resourceType: 'promo_opt_in',
          resourceId: claimed.id,
          after: { offerId, offerKey: offer.key },
        });
      }
      const [row] = await tx
        .select({ accumulatedDeposit: promoOptIn.accumulatedDeposit })
        .from(promoOptIn)
        .where(and(eq(promoOptIn.userId, userId), eq(promoOptIn.offerId, offerId)));
      return toPlayerOffer(offer, row?.accumulatedDeposit ?? '0', true);
    });
  }

  /**
   * A confirmed deposit, put toward every offer the player has taken. Deposits accumulate, so
   * two below the minimum still qualify - the progress bar the operator asked for is this column.
   *
   * Runs on the caller's transaction: the grant and the deposit that earned it commit together.
   */
  async applyDeposit(
    tx: DrizzleTx,
    deposit: { userId: Uuid; amount: string; currency: string; transactionId: Uuid },
    context: OfferContext = {},
  ): Promise<void> {
    // The deposit has already committed by the time this job runs, so a lifetime total equal to
    // this deposit means there was nothing before it. Asking the wallet keeps the fact where it
    // is owned rather than snapshotting it onto an event.
    const lifetime = await this.wallet.getLifetimeDeposit(deposit.userId);
    const isFirstDeposit = moneyCompare(lifetime, deposit.amount) === 0;
    const at = new Date();

    for (const { optIn, offer } of await this.claimsFor(tx, deposit)) {
      if (offer.currency !== deposit.currency) {
        continue;
      }
      // At-least-once delivery: the unique index is what stops a redelivered deposit adding
      // itself to the running total twice and paying a bonus the deposits never earned.
      const [counted] = await tx
        .insert(promoOptInDeposit)
        .values({ optInId: optIn.id, transactionId: deposit.transactionId, amount: deposit.amount })
        .onConflictDoNothing()
        .returning({ id: promoOptInDeposit.id });
      if (!counted) {
        continue;
      }

      const accumulated = moneyAdd(optIn.accumulatedDeposit, deposit.amount);
      const refusal = offerIneligibility({
        offer: toOffer(offer),
        at,
        isFirstDeposit,
        deposit: { amount: accumulated, currency: deposit.currency },
        ...context,
      });
      if (refusal !== null) {
        // Only a deposit short of the minimum banks toward it. Banking one the offer refused for
        // any other reason means re-activating a paused offer pays a match on every deposit made
        // while it was shut.
        if (refusal === 'below_minimum_deposit') {
          await tx
            .update(promoOptIn)
            .set({ accumulatedDeposit: accumulated })
            .where(eq(promoOptIn.id, optIn.id));
        }
        continue;
      }

      const amount = grantAmountFor(accumulated, offer.matchPercent, offer.maxGrantAmount);
      if (moneyCompare(amount, '0') <= 0) {
        continue;
      }

      const granted = await this.grants.grant(tx, {
        userId: deposit.userId,
        currency: offer.currency,
        amount,
        source: 'deposit',
        // Per offer, not per deposit: one deposit can qualify several claims, and a shared
        // reference would make the second one collide with the first.
        sourceRef: `${deposit.transactionId}:${offer.id}`,
        actor: { type: 'system' },
        offerId: offer.id,
        terms: offer.terms,
      });
      if (!granted.ok) {
        // The accumulator stays where it was: banking a total the grant refused would pay the
        // match on all of it the next time a deposit lands.
        this.logger.error(
          { userId: deposit.userId, offerId: offer.id, reason: granted.reason },
          'promo offer grant refused',
        );
        continue;
      }
      await tx
        .update(promoOptIn)
        .set({ accumulatedDeposit: accumulated, grantId: granted.grantId })
        .where(eq(promoOptIn.id, optIn.id));
    }
  }

  /**
   * The claims this deposit could satisfy: the ones the player took, plus the offers that need no
   * taking. An offer marked `requiresOptIn: false` applies to any qualifying deposit, so the claim
   * is opened here rather than requiring the player to ask for something already theirs.
   */
  private async claimsFor(
    tx: DrizzleTx,
    deposit: { userId: Uuid; currency: string },
  ): Promise<{ optIn: PromoOptInRow; offer: PromoOfferRow }[]> {
    const automatic = await tx
      .select({ id: promoOffer.id })
      .from(promoOffer)
      .where(and(eq(promoOffer.status, 'active'), eq(promoOffer.requiresOptIn, false)));
    if (automatic.length > 0) {
      await tx
        .insert(promoOptIn)
        .values(automatic.map(({ id }) => ({ userId: deposit.userId, offerId: id })))
        .onConflictDoNothing();
    }

    // `of` the opt-in only: locking the joined offer rows as well would put two deposits for
    // different players in a deadlock over the offers they happen to share.
    return tx
      .select({ optIn: promoOptIn, offer: promoOffer })
      .from(promoOptIn)
      .innerJoin(promoOffer, eq(promoOffer.id, promoOptIn.offerId))
      .where(and(eq(promoOptIn.userId, deposit.userId), sql`${promoOptIn.grantId} is null`))
      .for('update', { of: promoOptIn });
  }

  private async requireOffer(tx: DrizzleTx, id: Uuid): Promise<PromoOfferRow> {
    const [row] = await tx.select().from(promoOffer).where(eq(promoOffer.id, id));
    if (!row) {
      throw new OfferNotFoundError(id);
    }
    return row;
  }
}

function toOffer(row: PromoOfferRow): PromoOffer {
  return serializeRow(row, { dateFields: [...DATE_FIELDS], decimalFields: [...MONEY_FIELDS] });
}

function toPlayerOffer(
  row: PromoOfferRow,
  accumulatedDeposit: string,
  optedIn: boolean,
): PlayerOffer {
  const offer = toOffer(row);
  return {
    id: offer.id,
    key: offer.key,
    name: offer.name,
    currency: offer.currency,
    matchPercent: offer.matchPercent,
    maxGrantAmount: offer.maxGrantAmount,
    minDeposit: offer.minDeposit,
    requiresOptIn: offer.requiresOptIn,
    validUntil: offer.validUntil,
    wageringMultiplier: offer.terms.wageringMultiplier,
    optedIn,
    accumulatedDeposit,
  };
}

/** The wire carries timestamps as strings; the column wants dates, and null is a real value. */
function toPatch({ validFrom, validUntil, ...rest }: Partial<CreatePromoOfferInput>) {
  return {
    ...rest,
    ...(validFrom === undefined
      ? {}
      : { validFrom: validFrom === null ? null : new Date(validFrom) }),
    ...(validUntil === undefined
      ? {}
      : { validUntil: validUntil === null ? null : new Date(validUntil) }),
  };
}
