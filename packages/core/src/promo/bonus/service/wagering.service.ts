import { and, asc, eq, sql } from 'drizzle-orm';
import {
  type BonusSettleArgs,
  type BonusSettleOutcome,
  type BonusWagerArgs,
  type BonusWagerOutcome,
  type BonusWageringCommands,
  type Uuid,
  type WagerTrackingCommands,
} from '@openora/core/contracts';
import {
  moneyAdd,
  moneyCompare,
  moneyDivide,
  moneyScaleBy,
  moneySubtract,
  type DrizzleTx,
} from '@openora/core/server';
import {
  promoGrant,
  promoGrantEntry,
  type PromoGrant,
  type PromoGrantEntry,
} from '../schema/index.js';
import { resolveContributionPercent, weightedStake } from '../shared/wagering-weight.js';

const ZERO = '0';

/**
 * The wagering engine: what a bet does to a bonus, and what a win does back to it.
 *
 * Bound to the sealed BONUS_WAGERING token and always called on the wallet's own transaction,
 * below its duplicate-provider-reference guard, so a replayed wager can never reach it.
 *
 * It never calls back into the wallet. A completed grant is reported as `convertedAmount` and the
 * wallet, which already holds the transaction, performs the credit - so the two modules do not
 * depend on each other in both directions.
 */
export class WageringService implements BonusWageringCommands {
  constructor(private readonly wagerTracking?: WagerTrackingCommands) {}

  async wager(tx: DrizzleTx, args: BonusWagerArgs): Promise<BonusWagerOutcome> {
    const grant = await this.lockAttributedGrant(tx, args.userId, args.currency);

    if (!grant) {
      // A player with no live grant in this currency pays the whole stake in cash. Anything the
      // wallet could not cover is simply not available.
      return moneyCompare(args.fromBonus, ZERO) > 0
        ? { ok: false, bonusAvailable: ZERO }
        : {
            ok: true,
            grantId: null,
            bonusSpent: ZERO,
            weightedAmount: ZERO,
            bonusBalanceAfter: ZERO,
            completedGrantIds: [],
            convertedAmount: ZERO,
          };
    }

    const spent = await this.spendBonus(tx, grant.id, args.fromBonus);
    if (spent === null) {
      return { ok: false, bonusAvailable: grant.bonusBalance };
    }

    const percent = resolveContributionPercent(grant.terms.weights, args.context);
    const weighted = weightedStake(args.stake, percent);
    // The row is locked, so the progress read above is what the update starts from; the delta is
    // whatever the requirement still had room for.
    const headroom = moneySubtract(grant.wageringRequired, grant.wageringProgress);
    const applied = moneyCompare(weighted, headroom) < 0 ? weighted : headroom;
    const advanced = await this.advanceProgress(tx, grant.id, weighted);
    const completed = advanced?.status === 'completed';
    const convertedAmount = completed ? spent.balanceAfter : ZERO;
    const balanceAfter = completed ? ZERO : spent.balanceAfter;

    if (completed) {
      await this.closeCompleted(tx, grant.id);
    }

    await tx.insert(promoGrantEntry).values({
      grantId: grant.id,
      userId: args.userId,
      currency: args.currency,
      type: 'stake',
      bonusAmount: `-${args.fromBonus}`,
      realAmount: moneySubtract(args.stake, args.fromBonus),
      wageringDelta: advanced ? applied : ZERO,
      balanceAfter: spent.balanceAfter,
      ...(args.externalRoundId === undefined ? {} : { externalRoundId: args.externalRoundId }),
    });

    if (completed) {
      await tx.insert(promoGrantEntry).values({
        grantId: grant.id,
        userId: args.userId,
        currency: args.currency,
        type: 'convert',
        bonusAmount: `-${convertedAmount}`,
        balanceAfter: ZERO,
      });
    }

    await this.wagerTracking?.recordWager(tx, {
      userId: args.userId,
      currency: args.currency,
      amount: args.stake,
      weightedAmount: weighted,
      context: args.context,
    });

    return {
      ok: true,
      grantId: grant.id,
      bonusSpent: args.fromBonus,
      weightedAmount: weighted,
      bonusBalanceAfter: balanceAfter,
      completedGrantIds: completed ? [grant.id] : [],
      convertedAmount,
    };
  }

  async settle(tx: DrizzleTx, args: BonusSettleArgs): Promise<BonusSettleOutcome> {
    const stake = await this.roundStake(tx, args.userId, args.externalRoundId);
    if (!stake) {
      return { bonusShare: ZERO };
    }

    const total = moneyAdd(stake.bonusStake, stake.realStake);
    if (moneyCompare(stake.bonusStake, ZERO) <= 0 || moneyCompare(total, ZERO) <= 0) {
      return { bonusShare: ZERO };
    }

    // Truncating, so a rounding remainder lands on the real balance rather than the bonus one.
    const share = moneyDivide(moneyScaleBy(args.amount, stake.bonusStake), total);
    const applied =
      args.kind === 'win'
        ? await this.creditBonus(tx, stake.grantId, share)
        : await this.reverseRound(tx, stake.grantId, share, stake.weightedTotal);
    if (applied === null) {
      return { bonusShare: ZERO };
    }

    await tx.insert(promoGrantEntry).values({
      grantId: stake.grantId,
      userId: args.userId,
      currency: args.currency,
      type: args.kind === 'win' ? 'win' : 'reversal',
      bonusAmount: args.kind === 'win' ? share : `-${share}`,
      wageringDelta: args.kind === 'win' ? ZERO : `-${stake.weightedTotal}`,
      balanceAfter: applied,
      externalRoundId: args.externalRoundId,
    });

    return { bonusShare: share };
  }

  /**
   * One bet feeds exactly one grant, and only a grant held in the bet's own currency: the active
   * grant in that currency, earliest expiry first. A stable tiebreak keeps two concurrent bets
   * taking the same lock in the same order.
   */
  private async lockAttributedGrant(tx: DrizzleTx, userId: Uuid, currency: string) {
    const [row] = await tx
      .select({
        id: promoGrant.id,
        bonusBalance: promoGrant.bonusBalance,
        wageringRequired: promoGrant.wageringRequired,
        wageringProgress: promoGrant.wageringProgress,
        terms: promoGrant.terms,
      })
      .from(promoGrant)
      .where(
        and(
          eq(promoGrant.userId, userId),
          eq(promoGrant.currency, currency),
          eq(promoGrant.status, 'active'),
          sql`${promoGrant.expiresAt} > now()`,
        ),
      )
      .orderBy(asc(promoGrant.expiresAt), asc(promoGrant.createdAt), asc(promoGrant.id))
      .limit(1)
      .for('update');
    return row;
  }

  /** Conditional in SQL, so two concurrent bets cannot both pass a balance they then overdraw. */
  private async spendBonus(tx: DrizzleTx, grantId: PromoGrant['id'], amount: string) {
    if (moneyCompare(amount, ZERO) <= 0) {
      const [row] = await tx
        .select({ balanceAfter: promoGrant.bonusBalance })
        .from(promoGrant)
        .where(eq(promoGrant.id, grantId));
      return row ?? null;
    }
    const [row] = await tx
      .update(promoGrant)
      .set({ bonusBalance: sql`${promoGrant.bonusBalance} - ${amount}::numeric` })
      .where(
        and(
          eq(promoGrant.id, grantId),
          sql`${promoGrant.bonusBalance} >= ${amount}::numeric`,
          eq(promoGrant.status, 'active'),
        ),
      )
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ?? null;
  }

  /** Cap and completion in one statement: progress can never pass the requirement. */
  private async advanceProgress(tx: DrizzleTx, grantId: PromoGrant['id'], weighted: string) {
    const [row] = await tx
      .update(promoGrant)
      .set({
        wageringProgress: sql`LEAST(${promoGrant.wageringRequired}, ${promoGrant.wageringProgress} + ${weighted}::numeric)`,
        status: sql`(CASE WHEN ${promoGrant.wageringProgress} + ${weighted}::numeric >= ${promoGrant.wageringRequired} THEN 'completed' ELSE 'active' END)::promo_grant_status`,
      })
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({ status: promoGrant.status });
    return row ?? null;
  }

  private async closeCompleted(tx: DrizzleTx, grantId: PromoGrant['id']) {
    await tx
      .update(promoGrant)
      .set({ bonusBalance: ZERO, closedAt: sql`now()` })
      .where(eq(promoGrant.id, grantId));
  }

  private async roundStake(
    tx: DrizzleTx,
    userId: Uuid,
    round: NonNullable<PromoGrantEntry['externalRoundId']>,
  ) {
    const [row] = await tx
      .select({
        grantId: promoGrantEntry.grantId,
        bonusStake: sql<string>`(-sum(${promoGrantEntry.bonusAmount}))::text`,
        realStake: sql<string>`sum(${promoGrantEntry.realAmount})::text`,
        weightedTotal: sql<string>`sum(${promoGrantEntry.wageringDelta})::text`,
      })
      .from(promoGrantEntry)
      .where(
        and(
          eq(promoGrantEntry.userId, userId),
          eq(promoGrantEntry.externalRoundId, round),
          eq(promoGrantEntry.type, 'stake'),
        ),
      )
      .groupBy(promoGrantEntry.grantId)
      .limit(1);
    return row;
  }

  /** A grant that already completed, expired or was forfeited takes no more money. */
  private async creditBonus(tx: DrizzleTx, grantId: PromoGrant['id'], amount: string) {
    if (moneyCompare(amount, ZERO) <= 0) {
      return null;
    }
    const [row] = await tx
      .update(promoGrant)
      .set({ bonusBalance: sql`${promoGrant.bonusBalance} + ${amount}::numeric` })
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row?.balanceAfter ?? null;
  }

  /**
   * A voided round returns the bonus stake and takes back the progress it bought. Money back with
   * progress left standing is free wagering bought by a rollback.
   */
  private async reverseRound(
    tx: DrizzleTx,
    grantId: PromoGrant['id'],
    amount: string,
    weighted: string,
  ) {
    const [row] = await tx
      .update(promoGrant)
      .set({
        bonusBalance: sql`${promoGrant.bonusBalance} + ${amount}::numeric`,
        wageringProgress: sql`GREATEST(0, ${promoGrant.wageringProgress} - ${weighted}::numeric)`,
      })
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row?.balanceAfter ?? null;
  }
}
