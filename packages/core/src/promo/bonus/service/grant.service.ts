import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  MoneyAmountSchema,
  UuidSchema,
  type AuditWritePort,
  type BonusGrantArgs,
  type BonusGrantCommands,
  type BonusGrantOutcome,
} from '@openora/core/contracts';
import { isPositiveMoney, moneyScaleBy, type DrizzleTx } from '@openora/core/server';
import { BonusGrantSourceSchema } from '../contract/index.js';
import { promoGrant } from '../schema/index.js';

// Untrusted at the boundary: a caller is another module, and a malformed multiplier or a
// non-positive amount must be refused before it reaches the ledger, not corrected after.
const grantArgsSchema = z.object({
  userId: UuidSchema,
  currency: z.string().min(1),
  amount: MoneyAmountSchema.refine(isPositiveMoney, 'must be greater than zero'),
  source: BonusGrantSourceSchema,
  sourceRef: z.string().min(1),
  offerId: UuidSchema.optional(),
  terms: z.object({
    wageringMultiplier: MoneyAmountSchema,
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
        terms: args.terms,
        grantedAmount: args.amount,
        wageringRequired,
        expiresAt: sql`now() + make_interval(days => ${args.terms.expiryDays})`,
      })
      .onConflictDoNothing()
      .returning({ id: promoGrant.id });

    if (!inserted) {
      const [existing] = await tx
        .select({ id: promoGrant.id })
        .from(promoGrant)
        .where(
          and(
            eq(promoGrant.userId, args.userId),
            eq(promoGrant.source, args.source),
            eq(promoGrant.sourceRef, args.sourceRef),
          ),
        );
      if (!existing) {
        throw new Error('promo grant: insert conflicted but no existing grant was found');
      }
      return { ok: true, grantId: existing.id, created: false };
    }

    await this.audit.recordInTransaction(tx, {
      actorType: 'system',
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
        terms: args.terms,
      },
    });

    return { ok: true, grantId: inserted.id, created: true };
  }
}
