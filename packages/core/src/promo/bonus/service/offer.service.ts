import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  type AuditWritePort,
  type BonusGrantCommands,
  type PageQuery,
  type Uuid,
} from '@openora/core/contracts';
import {
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  moneyAdd,
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
import { promoOffer, promoOptIn, type PromoOffer as PromoOfferRow } from '../schema/index.js';
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

const DATE_FIELDS = ['validFrom', 'validUntil', 'createdAt', 'updatedAt'] as const;
const MONEY_FIELDS = ['matchPercent', 'maxGrantAmount', 'minDeposit'] as const;

type OfferContext = { countryCode?: string; isFirstDeposit?: boolean };

export class OfferService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly grants: BonusGrantCommands,
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
    const [row] = await this.drizzle.db.transaction(async (tx) => {
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
          ...toWindow(input),
        })
        .onConflictDoNothing({ target: promoOffer.key })
        .returning();
      if (inserted.length === 0) {
        throw new OfferKeyTakenError();
      }
      const created = findOneOrThrow(inserted, new OfferKeyTakenError());
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.offer.created',
        resourceType: 'promo_offer',
        resourceId: created.id,
        after: toOffer(created),
      });
      return inserted;
    });
    return toOffer(findOneOrThrow([row], new OfferKeyTakenError()));
  }

  async update(adminId: Uuid, input: UpdatePromoOfferInput): Promise<PromoOffer> {
    const { id, ...patch } = input;
    return this.drizzle.db.transaction(async (tx) => {
      const before = await this.requireOffer(tx, id);
      const [updated] = await tx
        .update(promoOffer)
        .set({ ...stripWindow(patch), ...toWindow(patch) })
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
      await tx.insert(promoOptIn).values({ userId, offerId }).onConflictDoNothing();
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
    const claims = await tx
      .select({ optIn: promoOptIn, offer: promoOffer })
      .from(promoOptIn)
      .innerJoin(promoOffer, eq(promoOffer.id, promoOptIn.offerId))
      .where(and(eq(promoOptIn.userId, deposit.userId), sql`${promoOptIn.grantId} is null`))
      .for('update');

    const at = new Date();
    for (const { optIn, offer } of claims) {
      if (offer.currency !== deposit.currency) {
        continue;
      }
      const accumulated = moneyAdd(optIn.accumulatedDeposit, deposit.amount);
      const refusal = offerIneligibility({
        offer: toOffer(offer),
        at,
        deposit: { amount: accumulated, currency: deposit.currency },
        ...context,
      });
      if (refusal !== null) {
        // Short of the minimum is the common case and not a failure: the deposit counts toward
        // it and the player deposits again.
        await tx
          .update(promoOptIn)
          .set({ accumulatedDeposit: accumulated })
          .where(eq(promoOptIn.id, optIn.id));
        continue;
      }

      const granted = await this.grants.grant(tx, {
        userId: deposit.userId,
        currency: offer.currency,
        amount: grantAmountFor(accumulated, offer.matchPercent, offer.maxGrantAmount),
        source: 'deposit',
        // The deposit that tipped it over, so a replayed deposit resolves to the same grant.
        sourceRef: deposit.transactionId,
        actor: { type: 'system' },
        offerId: offer.id,
        terms: offer.terms,
      });
      await tx
        .update(promoOptIn)
        .set({
          accumulatedDeposit: accumulated,
          ...(granted.ok ? { grantId: granted.grantId } : {}),
        })
        .where(eq(promoOptIn.id, optIn.id));
    }
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

function stripWindow(patch: Partial<CreatePromoOfferInput>) {
  const { validFrom: _from, validUntil: _until, ...rest } = patch;
  return rest;
}

/** The wire carries timestamps as strings; the column wants dates, and null is a real value. */
function toWindow({ validFrom, validUntil }: Partial<CreatePromoOfferInput>) {
  return {
    ...(validFrom === undefined
      ? {}
      : { validFrom: validFrom === null ? null : new Date(validFrom) }),
    ...(validUntil === undefined
      ? {}
      : { validUntil: validUntil === null ? null : new Date(validUntil) }),
  };
}
