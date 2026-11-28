import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  BonusGrantSourceSchema,
  CurrencyTickerInputSchema,
  MoneyAmountSchema,
  UuidSchema,
  GrantSlotTakenPolicySchema,
  WagerProductSchema,
  type AuditWritePort,
  type BonusGrantArgs,
  type BonusGrantCommands,
  type BonusFundSettings,
  type BonusGrantOutcome,
  type GrantConcurrencyMode,
  type ExchangeRateReader,
} from '@openora/core/contracts';
import {
  isPositiveMoney,
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  moneyScaleBy,
  type DrizzleTx,
} from '@openora/core/server';
import {
  promoGrant,
  promoGrantEntry,
  promoWeight,
  promoWeightProfile,
  type GrantTermsSnapshot,
} from '../schema/index.js';
import { BonusFundSettingsSchema } from '../contract/index.js';
import { DEFAULT_FUND_SETTINGS } from '../shared/fund-buckets.js';
import { maxBetTermsIssues, resolveMaxBet } from '../shared/max-bet.js';
import { isSlotTaken, withGrantSlotLock } from '../shared/grant-slot.js';

const WagerWeightProfileNotFoundError = makeNotFoundError('WagerWeightProfile');
const GrantConflictError = makeConflictError(
  'GrantConflictError',
  'A different grant already exists for this source reference',
);
const UnusableWeightProfileError = makeConflictError(
  'UnusableWeightProfileError',
  'This weight profile has no positive weight, so no wager could ever progress a grant on it',
);

const MAX_WAGERING_MULTIPLIER = '1000';

const MAX_EXPIRY_DAYS = 3650;

export const DEFAULT_WEIGHT_PROFILE_NAME = 'default';

const DEFAULT_GRANT_TERMS = { wageringMultiplier: '1', expiryDays: 30 } as const;

const grantArgsSchema = z
  .object({
    userId: UuidSchema,
    currency: CurrencyTickerInputSchema,
    amount: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero'),
    source: BonusGrantSourceSchema,
    sourceRef: z.string().min(1),
    actor: z.union([
      z.object({ type: z.literal('admin'), id: UuidSchema }),
      z.object({ type: z.literal('system') }),
    ]),
    offerId: UuidSchema.optional(),
    terms: z
      .object({
        wageringMultiplier: MoneyAmountSchema.refine(
          isPositiveMoney,
          'must be greater than zero',
        ).refine(
          (v) => moneyCompare(v, MAX_WAGERING_MULTIPLIER) <= 0,
          `must not exceed ${MAX_WAGERING_MULTIPLIER}`,
        ),
        expiryDays: z.number().int().positive().max(MAX_EXPIRY_DAYS),
        weightProfileId: UuidSchema.optional(),
        maxBet: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero')
          .nullable()
          .optional(),
        maxWinMultiplier: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero')
          .nullable()
          .optional(),
        excludedProducts: z.array(WagerProductSchema).optional(),
        maxBetRate: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero')
          .nullable()
          .optional(),
        maxBetFloor: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero')
          .nullable()
          .optional(),
        maxBetCeiling: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero')
          .nullable()
          .optional(),
        maxBetExemptProducts: z.array(WagerProductSchema).optional(),
        funds: BonusFundSettingsSchema.optional(),
        allowPlayerForfeit: z.boolean().optional(),
      })
      .superRefine((terms, ctx) => {
        for (const message of maxBetTermsIssues(terms)) {
          ctx.addIssue({ code: 'custom', message });
        }
      })
      .default(DEFAULT_GRANT_TERMS),
    onSlotTaken: GrantSlotTakenPolicySchema.default('pending'),
    buckets: z.object({ linked: MoneyAmountSchema, unlinked: MoneyAmountSchema }).optional(),
    wageringRequired: MoneyAmountSchema.refine(
      isPositiveMoney,
      'must be greater than zero',
    ).optional(),
  })
  .refine((a) => (a.source === 'manual') === (a.actor.type === 'admin'), {
    message: 'a manual grant must name the admin who issued it, and no other source may name one',
    path: ['actor'],
  })
  .refine((a) => MoneyAmountSchema.safeParse(requirementOf(a)).success, {
    message: 'wagering requirement is too large to store',
    path: ['amount'],
  });

function requirementOf(args: {
  amount: string;
  terms: { wageringMultiplier: string };
  wageringRequired?: string;
}): string {
  return args.wageringRequired ?? moneyScaleBy(args.amount, args.terms.wageringMultiplier);
}

export class GrantService implements BonusGrantCommands {
  constructor(
    private readonly audit: AuditWritePort,
    private readonly concurrency: GrantConcurrencyMode = 'multiple',
    private readonly rates?: ExchangeRateReader,
  ) {}

  async grant(tx: DrizzleTx, rawArgs: BonusGrantArgs): Promise<BonusGrantOutcome> {
    const args = grantArgsSchema.parse(rawArgs);
    return withGrantSlotLock(tx, this.concurrency, args.userId, args.currency, () =>
      this.grantLocked(tx, args),
    );
  }

  private async grantLocked(
    tx: DrizzleTx,
    args: z.infer<typeof grantArgsSchema>,
  ): Promise<BonusGrantOutcome> {
    const wageringRequired = requirementOf(args);

    const replayed = await this.findReplay(tx, args, wageringRequired);
    if (replayed) {
      return replayed;
    }
    const slotTaken = await isSlotTaken(tx, this.concurrency, args);
    if (slotTaken && args.onSlotTaken === 'refuse') {
      return { ok: false, reason: 'slot_taken' };
    }
    const status = slotTaken ? 'pending' : 'active';
    const terms = {
      ...(await this.snapshotTerms(tx, args.terms, args.amount)),
      dustThreshold: await this.dustThreshold(tx, args.terms.funds, args.currency),
    };
    const buckets = args.buckets ?? { linked: '0', unlinked: '0' };

    const [inserted] = await tx
      .insert(promoGrant)
      .values({
        userId: args.userId,
        currency: args.currency,
        source: args.source,
        sourceRef: args.sourceRef,
        offerId: args.offerId ?? null,
        terms,
        grantedAmount: args.amount,
        bonusBalance: args.amount,
        wageringRequired,
        linkedCash: buckets.linked,
        unlinkedCash: buckets.unlinked,
        status,
        expiresAt: sql`now() + make_interval(days => ${args.terms.expiryDays})`,
        activatedAt: status === 'active' ? sql`now()` : null,
      })
      .onConflictDoNothing()
      .returning({ id: promoGrant.id });

    if (!inserted) {
      const winner = await this.findReplay(tx, args, wageringRequired);
      if (!winner) {
        throw new GrantConflictError();
      }
      return winner;
    }

    await tx.insert(promoGrantEntry).values({
      grantId: inserted.id,
      userId: args.userId,
      currency: args.currency,
      type: 'grant',
      bonusAmount: args.amount,
      balanceAfter: args.amount,
    });

    await this.audit.recordInTransaction(tx, {
      ...(args.actor.type === 'admin' ? { actorId: args.actor.id } : {}),
      actorType: args.actor.type,
      action: 'promo.bonus.granted',
      resourceType: 'promo_grant',
      resourceId: inserted.id,
      after: {
        userId: args.userId,
        currency: args.currency,
        source: args.source,
        sourceRef: args.sourceRef,
        grantedAmount: args.amount,
        wageringRequired,
        wageringMultiplier: args.terms.wageringMultiplier,
        expiryDays: args.terms.expiryDays,
        weightProfileId: terms.weightProfileId,
        maxBet: terms.maxBet ?? null,
        status,
        linkedCash: buckets.linked,
        unlinkedCash: buckets.unlinked,
        ...(args.terms.funds === undefined ? {} : { funds: args.terms.funds }),
        ...(args.terms.allowPlayerForfeit === undefined
          ? {}
          : { allowPlayerForfeit: args.terms.allowPlayerForfeit }),
      },
    });

    return { ok: true, grantId: inserted.id, created: true, status };
  }

  private async findReplay(
    tx: DrizzleTx,
    args: z.infer<typeof grantArgsSchema>,
    wageringRequired: string,
  ): Promise<BonusGrantOutcome | undefined> {
    const [existing] = await tx
      .select({
        id: promoGrant.id,
        currency: promoGrant.currency,
        grantedAmount: promoGrant.grantedAmount,
        wageringRequired: promoGrant.wageringRequired,
        status: promoGrant.status,
      })
      .from(promoGrant)
      .where(
        and(
          eq(promoGrant.userId, args.userId),
          eq(promoGrant.source, args.source),
          eq(promoGrant.sourceRef, args.sourceRef),
        ),
      );
    if (!existing) {
      return undefined;
    }
    const matches =
      existing.currency === args.currency &&
      moneyCompare(existing.grantedAmount, args.amount) === 0 &&
      moneyCompare(existing.wageringRequired, wageringRequired) === 0;
    if (!matches) {
      throw new GrantConflictError();
    }
    return { ok: true, grantId: existing.id, created: false, status: existing.status };
  }

  private async dustThreshold(
    tx: DrizzleTx,
    funds: BonusFundSettings | undefined,
    currency: string,
  ): Promise<string> {
    const usd = (funds ?? DEFAULT_FUND_SETTINGS).dustThresholdUsd;
    if (moneyCompare(usd, '0') <= 0) {
      return '0';
    }
    if (currency === 'USD') {
      return usd;
    }
    return (await this.rates?.convert(usd, 'USD', currency, tx)) ?? '0';
  }

  private async snapshotTerms(
    tx: DrizzleTx,
    terms: NonNullable<BonusGrantArgs['terms']>,
    grantedAmount: string,
  ): Promise<GrantTermsSnapshot> {
    const rows = await tx
      .select({
        profileId: promoWeightProfile.id,
        contributionMode: promoWeightProfile.contributionMode,
        referenceEdge: promoWeightProfile.referenceEdge,
        version: promoWeightProfile.version,
        scope: promoWeight.scope,
        scopeRef: promoWeight.scopeRef,
        contributionPercent: promoWeight.contributionPercent,
      })
      .from(promoWeightProfile)
      .leftJoin(promoWeight, eq(promoWeight.profileId, promoWeightProfile.id))
      .where(
        terms.weightProfileId === undefined
          ? eq(promoWeightProfile.name, DEFAULT_WEIGHT_PROFILE_NAME)
          : eq(promoWeightProfile.id, terms.weightProfileId),
      );

    const profile = rows[0];
    if (profile === undefined) {
      throw new WagerWeightProfileNotFoundError(
        terms.weightProfileId ?? DEFAULT_WEIGHT_PROFILE_NAME,
      );
    }
    const weights = rows.flatMap((r) =>
      r.scope && r.contributionPercent
        ? [{ scope: r.scope, scopeRef: r.scopeRef, contributionPercent: r.contributionPercent }]
        : [],
    );
    const hasUsableWeight = weights.some((w) => moneyCompare(w.contributionPercent, '0') > 0);
    if (!hasUsableWeight) {
      throw new UnusableWeightProfileError();
    }
    const maxBet = resolveMaxBet(grantedAmount, terms);
    return {
      ...terms,
      weightProfileId: profile.profileId,
      weights,
      contributionMode: profile.contributionMode,
      ...(profile.referenceEdge === null ? {} : { referenceEdge: profile.referenceEdge }),
      weightProfileVersion: profile.version,
      ...(maxBet === null ? {} : { maxBet }),
    };
  }
}
