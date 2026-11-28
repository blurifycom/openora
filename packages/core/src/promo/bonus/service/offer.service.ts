import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  type AuditWritePort,
  type BonusGrantCommands,
  type GrantConcurrencyMode,
  type PageQuery,
  type PlayEligibilityPort,
  type Uuid,
  type WalletReader,
} from '@openora/core/contracts';
import {
  createDomainError,
  findOneOrThrow,
  makeConflictError,
  makeNotFoundError,
  moneyScaleBy,
  moneyCompare,
  moneySubtract,
  pageToOffset,
  serializeRow,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type {
  CreatePromoOfferInput,
  PlayerOffer,
  PromoOffer,
  PublicOffer,
  UpdatePromoOfferInput,
} from '../contract/index.js';
import {
  promoGrant,
  promoGrantDeposit,
  promoOffer,
  promoOptIn,
  promoOptInDeposit,
  type PromoGrant,
  type PromoOffer as PromoOfferRow,
  type PromoOptIn as PromoOptInRow,
} from '../schema/index.js';
import { maxBetTermsIssues } from '../shared/max-bet.js';
import { BonusSlotTakenError, isSlotTaken } from '../shared/grant-slot.js';
import { DEFAULT_FUND_SETTINGS, depositBuckets, wageringBase } from '../shared/fund-buckets.js';
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

export const InvalidOfferTermsError = createDomainError<[reason: string]>(
  'InvalidOfferTermsError',
  (reason) => reason,
);

const DATE_FIELDS = ['validFrom', 'validUntil', 'createdAt', 'updatedAt'] as const;
const MONEY_FIELDS = ['matchPercent', 'maxGrantAmount', 'minDeposit'] as const;

const isDepositTriggered = sql`${promoOffer.rules} ->> 'periodDays' is null`;

type OfferContext = { isFirstDeposit?: boolean };

export type GrantedBonus = {
  userId: Uuid;
  grantId: Uuid;
  currency: string;
  grantedAmount: string;
  wageringRequired: string;
  offerId: Uuid;
};

export class OfferService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly grants: BonusGrantCommands,
    private readonly wallet: WalletReader,
    private readonly playEligibility: PlayEligibilityPort,
    private readonly logger: { error: (context: object, message: string) => void },
    private readonly concurrency: GrantConcurrencyMode = 'multiple',
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
    assertCoherentTerms(input.terms);
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
    if (patch.terms) {
      assertCoherentTerms(patch.terms);
    }
    return this.drizzle.db.transaction(async (tx) => {
      const before = await this.requireOffer(tx, id);
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

  private async offerFacts(userId: Uuid, context: OfferContext): Promise<OfferContext> {
    if (context.isFirstDeposit !== undefined) {
      return context;
    }
    const lifetime = await this.wallet.getLifetimeDeposit(userId);
    return { ...context, isFirstDeposit: lifetime !== null && moneyCompare(lifetime, '0') === 0 };
  }

  private async isFirstDepositByLifetimeTotal(userId: Uuid, depositAmount: string, tx?: unknown) {
    const lifetime = await this.wallet.getLifetimeDeposit(userId, tx);
    return lifetime !== null && moneyCompare(lifetime, depositAmount) === 0;
  }

  private async firstQualifying(
    userId: Uuid,
    offer: PromoOfferRow,
    context: OfferContext,
    scope: { tx?: DrizzleTx; before?: Uuid } = {},
  ): Promise<boolean | undefined> {
    if (
      !offer.rules.firstDepositOnly ||
      context.isFirstDeposit !== undefined ||
      !this.wallet.hasQualifyingDeposit
    ) {
      return undefined;
    }
    const earlier = await this.wallet.hasQualifyingDeposit(
      userId,
      { currency: offer.currency, minAmount: offer.minDeposit, before: scope.before },
      scope.tx,
    );
    return !earlier;
  }

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
    const facts = await this.offerFacts(userId, context);
    const open: PlayerOffer[] = [];
    for (const { offer, optIn } of rows) {
      const isFirstDeposit =
        (await this.firstQualifying(userId, offer, context)) ?? facts.isFirstDeposit;
      if (offerIneligibility({ offer: toOffer(offer), at, ...facts, isFirstDeposit }) === null) {
        open.push(toPlayerOffer(offer, optIn));
      }
    }
    return open;
  }

  async listPublic(): Promise<PublicOffer[]> {
    const rows = await this.drizzle.db
      .select()
      .from(promoOffer)
      .where(eq(promoOffer.status, 'active'))
      .orderBy(asc(promoOffer.minDeposit));
    const at = new Date();
    return rows
      .filter(
        (offer) => offerIneligibility({ offer: toOffer(offer), at, isFirstDeposit: true }) === null,
      )
      .map(toPublicOffer);
  }

  async optIn(userId: Uuid, offerId: Uuid, context: OfferContext = {}): Promise<PlayerOffer> {
    if (await this.playEligibility.isRestricted(userId)) {
      throw new OfferNotEligibleError();
    }
    const facts = await this.offerFacts(userId, context);
    return this.drizzle.db.transaction(async (tx) => {
      const offer = await this.requireOffer(tx, offerId);
      const isFirstDeposit =
        (await this.firstQualifying(userId, offer, context, { tx })) ?? facts.isFirstDeposit;
      const refusal = offerIneligibility({
        offer: toOffer(offer),
        at: new Date(),
        ...facts,
        isFirstDeposit,
      });
      if (refusal !== null) {
        throw new OfferNotEligibleError();
      }
      if (
        offer.rules.periodDays === undefined &&
        (await isSlotTaken(tx, this.concurrency, {
          userId,
          currency: offer.currency,
          source: 'deposit',
        }))
      ) {
        throw new BonusSlotTakenError();
      }
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
        .select()
        .from(promoOptIn)
        .where(and(eq(promoOptIn.userId, userId), eq(promoOptIn.offerId, offerId)));
      return toPlayerOffer(offer, row ?? null);
    });
  }

  async applyDeposit(
    tx: DrizzleTx,
    deposit: { userId: Uuid; amount: string; currency: string; transactionId: Uuid },
    context: OfferContext = {},
  ): Promise<GrantedBonus[]> {
    const isFirstDeposit = this.wallet.isFirstDeposit
      ? await this.wallet.isFirstDeposit(deposit.userId, deposit.transactionId, tx)
      : await this.isFirstDepositByLifetimeTotal(deposit.userId, deposit.amount, tx);
    const isRestricted = await this.playEligibility.isRestricted(deposit.userId, tx);
    const at = new Date();
    const granted: GrantedBonus[] = [];
    let realBalance: string | null = null;
    const currentRealBalance = async () => {
      realBalance ??=
        (await this.wallet.getBalances(deposit.userId, tx)).balances.find(
          (row) => row.currency === deposit.currency,
        )?.balance ?? '0';
      return realBalance;
    };

    for (const { optIn, offer } of await this.claimsFor(tx, deposit)) {
      if (offer.currency !== deposit.currency) {
        continue;
      }
      const [counted] = await tx
        .insert(promoOptInDeposit)
        .values({ optInId: optIn.id, transactionId: deposit.transactionId, amount: deposit.amount })
        .onConflictDoNothing()
        .returning({ id: promoOptInDeposit.id });
      if (!counted) {
        continue;
      }

      const refusal = offerIneligibility({
        offer: toOffer(offer),
        at,
        isFirstDeposit:
          (await this.firstQualifying(deposit.userId, offer, context, {
            tx,
            before: deposit.transactionId,
          })) ?? isFirstDeposit,
        deposit: { amount: deposit.amount, currency: deposit.currency },
        ...context,
      });
      if (refusal !== null || isRestricted) {
        continue;
      }

      const funds = offer.terms.funds ?? DEFAULT_FUND_SETTINGS;
      const buckets = depositBuckets({
        deposit: deposit.amount,
        matchPercent: offer.matchPercent,
        maxGrantAmount: offer.maxGrantAmount,
        decimals: funds.decimals,
      });
      const amount = buckets.bonus;
      if (moneyCompare(amount, '0') <= 0) {
        continue;
      }

      const unlinked =
        funds.existingBalance === 'locked'
          ? positiveOrZero(moneySubtract(await currentRealBalance(), buckets.linked))
          : buckets.unlinked;
      const wageringRequired = moneyScaleBy(
        wageringBase(funds.rolloverBase, buckets),
        offer.terms.wageringMultiplier,
      );
      const created = await this.grants.grant(tx, {
        userId: deposit.userId,
        currency: offer.currency,
        amount,
        buckets: { linked: buckets.linked, unlinked },
        wageringRequired,
        source: 'deposit',
        sourceRef: `${deposit.transactionId}:${offer.id}`,
        actor: { type: 'system' },
        offerId: offer.id,
        terms: offer.terms,
        onSlotTaken: 'refuse',
      });
      if (!created.ok && created.reason === 'slot_taken') {
        continue;
      }
      if (!created.ok) {
        this.logger.error(
          { userId: deposit.userId, offerId: offer.id, reason: created.reason },
          'promo offer grant refused',
        );
        continue;
      }
      await tx
        .update(promoOptIn)
        .set({ accumulatedDeposit: deposit.amount, grantId: created.grantId })
        .where(eq(promoOptIn.id, optIn.id));
      granted.push({
        userId: deposit.userId,
        grantId: created.grantId,
        currency: offer.currency,
        grantedAmount: amount,
        wageringRequired,
        offerId: offer.id,
      });
    }

    const earned = granted.find((bonus) => bonus.currency === deposit.currency);
    if (earned) {
      await this.countDeposit(tx, deposit, earned.grantId);
    } else if (!isRestricted) {
      await this.addToUnlinked(tx, deposit);
    }
    return granted;
  }

  private async addToUnlinked(
    tx: DrizzleTx,
    deposit: { userId: Uuid; amount: string; currency: string; transactionId: Uuid },
  ) {
    const [grant] = await tx
      .select({ id: promoGrant.id })
      .from(promoGrant)
      .where(
        and(
          eq(promoGrant.userId, deposit.userId),
          eq(promoGrant.currency, deposit.currency),
          eq(promoGrant.status, 'active'),
          sql`${promoGrant.expiresAt} > now()`,
        ),
      )
      .orderBy(asc(promoGrant.expiresAt), asc(promoGrant.createdAt), asc(promoGrant.id))
      .limit(1)
      .for('update');
    if (!grant || !(await this.countDeposit(tx, deposit, grant.id))) {
      return;
    }
    await tx
      .update(promoGrant)
      .set({ unlinkedCash: sql`${promoGrant.unlinkedCash} + ${deposit.amount}::numeric` })
      .where(eq(promoGrant.id, grant.id));
  }

  private async countDeposit(
    tx: DrizzleTx,
    deposit: { amount: string; transactionId: Uuid },
    grantId: PromoGrant['id'],
  ): Promise<boolean> {
    const inserted = await tx
      .insert(promoGrantDeposit)
      .values({ transactionId: deposit.transactionId, grantId, amount: deposit.amount })
      .onConflictDoNothing()
      .returning({ transactionId: promoGrantDeposit.transactionId });
    return inserted.length > 0;
  }

  private async claimsFor(
    tx: DrizzleTx,
    deposit: { userId: Uuid; currency: string },
  ): Promise<{ optIn: PromoOptInRow; offer: PromoOfferRow }[]> {
    const automatic = await tx
      .select({ id: promoOffer.id })
      .from(promoOffer)
      .where(
        and(
          eq(promoOffer.status, 'active'),
          eq(promoOffer.requiresOptIn, false),
          eq(promoOffer.currency, deposit.currency),
          isDepositTriggered,
        ),
      );
    if (automatic.length > 0) {
      await tx
        .insert(promoOptIn)
        .values(automatic.map(({ id }) => ({ userId: deposit.userId, offerId: id })))
        .onConflictDoNothing();
    }

    return tx
      .select({ optIn: promoOptIn, offer: promoOffer })
      .from(promoOptIn)
      .innerJoin(promoOffer, eq(promoOffer.id, promoOptIn.offerId))
      .where(
        and(
          eq(promoOptIn.userId, deposit.userId),
          sql`${promoOptIn.grantId} is null`,
          isDepositTriggered,
        ),
      )
      .for('update', { of: promoOptIn });
  }

  private async requireOffer(tx: DrizzleTx, id: Uuid): Promise<PromoOfferRow> {
    const [row] = await tx.select().from(promoOffer).where(eq(promoOffer.id, id)).for('update');
    if (!row) {
      throw new OfferNotFoundError(id);
    }
    return row;
  }
}

export function assertCoherentTerms(terms: PromoOffer['terms']) {
  const [issue] = maxBetTermsIssues(terms);
  if (issue !== undefined) {
    throw new InvalidOfferTermsError(issue);
  }
}

const positiveOrZero = (amount: string) => (moneyCompare(amount, '0') > 0 ? amount : '0');

function toOffer(row: PromoOfferRow): PromoOffer {
  return serializeRow(row, { dateFields: [...DATE_FIELDS], decimalFields: [...MONEY_FIELDS] });
}

function toPlayerOffer(row: PromoOfferRow, optIn: PromoOptInRow | null): PlayerOffer {
  return {
    ...toPublicOffer(row),
    optedIn: optIn !== null,
    claimed: optIn !== null && optIn.grantId !== null,
    accumulatedDeposit: optIn?.accumulatedDeposit ?? '0',
  };
}

function toPublicOffer(row: PromoOfferRow): PublicOffer {
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
  };
}

export function toPatch({ validFrom, validUntil, ...rest }: Partial<CreatePromoOfferInput>) {
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
