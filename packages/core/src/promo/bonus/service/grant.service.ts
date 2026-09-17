import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  CurrencyTickerInputSchema,
  MoneyAmountSchema,
  UuidSchema,
  type AuditWritePort,
  type BonusGrantArgs,
  type BonusGrantCommands,
  type BonusGrantOutcome,
} from '@openora/core/contracts';
import {
  isPositiveMoney,
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  moneyScaleBy,
  type DrizzleTx,
} from '@openora/core/server';
import { BonusGrantSourceSchema } from '../contract/index.js';
import {
  promoGrant,
  promoGrantEntry,
  promoWeight,
  promoWeightProfile,
  type GrantTermsSnapshot,
} from '../schema/index.js';

export const WagerWeightProfileNotFoundError = makeNotFoundError('WagerWeightProfile');
export const GrantConflictError = makeConflictError(
  'GrantConflictError',
  'A different grant already exists for this source reference',
);

// A requirement of zero converts the moment it is created, and a multiplier in the thousands is
// a fat finger rather than an offer. Both are refused before anything reaches the ledger.
const MAX_WAGERING_MULTIPLIER = '1000';

const grantArgsSchema = z.object({
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
  terms: z.object({
    wageringMultiplier: MoneyAmountSchema.refine(
      isPositiveMoney,
      'must be greater than zero',
    ).refine(
      (v) => moneyCompare(v, MAX_WAGERING_MULTIPLIER) <= 0,
      `must not exceed ${MAX_WAGERING_MULTIPLIER}`,
    ),
    expiryDays: z.number().int().positive(),
    weightProfileId: UuidSchema,
  }),
});

/**
 * Creates the bonuses a player holds. Bound to BONUS_GRANTS, and always called on the caller's
 * transaction handle so the grant commits with whatever earned it.
 */
export class GrantService implements BonusGrantCommands {
  constructor(private readonly audit: AuditWritePort) {}

  async grant(tx: DrizzleTx, rawArgs: BonusGrantArgs): Promise<BonusGrantOutcome> {
    const args = grantArgsSchema.parse(rawArgs);
    const wageringRequired = moneyScaleBy(args.amount, args.terms.wageringMultiplier);
    const terms = await this.snapshotTerms(tx, args.terms);

    // The unique index is the idempotency guard. A read-then-write check would let two
    // concurrent replays of the same deposit both pass and grant the bonus twice.
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
        expiresAt: sql`now() + make_interval(days => ${args.terms.expiryDays})`,
        activatedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ id: promoGrant.id });

    if (!inserted) {
      return this.resolveReplay(tx, args, wageringRequired);
    }

    // The opening ledger row. Written only on the created path, so a replay leaves the ledger
    // alone and the sum of a grant's entries still equals its bonus balance.
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
        weightProfileId: args.terms.weightProfileId,
      },
    });

    return { ok: true, grantId: inserted.id, created: true };
  }

  /**
   * A replay resolves to the grant that already exists - but only if it is the same grant. Two
   * different payouts sharing one source reference would otherwise return success while crediting
   * nothing, and the caller would record a payout that never happened.
   */
  private async resolveReplay(
    tx: DrizzleTx,
    args: z.infer<typeof grantArgsSchema>,
    wageringRequired: string,
  ): Promise<BonusGrantOutcome> {
    const [existing] = await tx
      .select({
        id: promoGrant.id,
        currency: promoGrant.currency,
        grantedAmount: promoGrant.grantedAmount,
        wageringRequired: promoGrant.wageringRequired,
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
      throw new GrantConflictError();
    }
    const matches =
      existing.currency === args.currency &&
      moneyCompare(existing.grantedAmount, args.amount) === 0 &&
      moneyCompare(existing.wageringRequired, wageringRequired) === 0;
    if (!matches) {
      throw new GrantConflictError();
    }
    return { ok: true, grantId: existing.id, created: false };
  }

  // One statement, so a profile deleted or edited mid-grant yields either its old rows or a
  // missing profile, never a half-read set of weights.
  private async snapshotTerms(
    tx: DrizzleTx,
    terms: BonusGrantArgs['terms'],
  ): Promise<GrantTermsSnapshot> {
    const rows = await tx
      .select({
        scope: promoWeight.scope,
        scopeRef: promoWeight.scopeRef,
        contributionPercent: promoWeight.contributionPercent,
      })
      .from(promoWeightProfile)
      .leftJoin(promoWeight, eq(promoWeight.profileId, promoWeightProfile.id))
      .where(eq(promoWeightProfile.id, terms.weightProfileId));

    if (rows.length === 0) {
      throw new WagerWeightProfileNotFoundError(terms.weightProfileId);
    }
    const weights = rows.flatMap((r) =>
      r.scope && r.contributionPercent
        ? [{ scope: r.scope, scopeRef: r.scopeRef, contributionPercent: r.contributionPercent }]
        : [],
    );
    return { ...terms, weights };
  }
}
