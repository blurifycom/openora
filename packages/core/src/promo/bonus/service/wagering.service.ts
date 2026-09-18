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
  makeConflictError,
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

export const GrantNotReversibleError = makeConflictError(
  'GrantNotReversibleError',
  'the grant that funded this round is no longer active, so the stake cannot be returned to it',
);

type RoundStake = {
  grantId: PromoGrant['id'];
  bonusStake: string;
  realStake: string;
  weightedTotal: string;
};

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
    const stakes = await this.roundStakes(tx, args.userId, args.externalRoundId);
    const totalBonus = stakes.reduce((sum, stake) => moneyAdd(sum, stake.bonusStake), ZERO);
    const totalStake = stakes.reduce((sum, stake) => moneyAdd(sum, stake.realStake), totalBonus);
    if (moneyCompare(totalBonus, ZERO) <= 0 || moneyCompare(totalStake, ZERO) <= 0) {
      return { bonusShare: ZERO };
    }

    if (args.kind === 'bet_reversal' && (await this.alreadyReversed(tx, args.externalRoundId))) {
      return { bonusShare: ZERO };
    }

    // Truncating, so a rounding remainder lands on the real balance rather than the bonus one.
    const share = moneyDivide(moneyScaleBy(args.amount, totalBonus), totalStake);

    let settled = ZERO;
    for (const [index, stake] of stakes.entries()) {
      // Each grant takes the part of the share its own funding paid for; the last takes whatever
      // truncation left over, so the parts always add back up to the share.
      const slice =
        index === stakes.length - 1
          ? moneySubtract(share, settled)
          : moneyDivide(moneyScaleBy(share, stake.bonusStake), totalBonus);
      if (moneyCompare(slice, ZERO) <= 0) {
        continue;
      }

      const applied =
        args.kind === 'win'
          ? await this.creditBonus(tx, stake.grantId, slice)
          : await this.reverseRound(tx, stake, slice);
      if (applied === null) {
        // A win on a grant that has already completed belongs to the real balance: its bonus
        // funds converted at completion. A reversal does not - returning a bonus-funded stake as
        // real money releases it without the wagering it was granted under.
        if (args.kind === 'bet_reversal') {
          throw new GrantNotReversibleError();
        }
        continue;
      }
      settled = moneyAdd(settled, slice);

      await tx.insert(promoGrantEntry).values({
        grantId: stake.grantId,
        userId: args.userId,
        currency: args.currency,
        type: args.kind === 'win' ? 'win' : 'reversal',
        bonusAmount: args.kind === 'win' ? slice : `-${slice}`,
        wageringDelta: args.kind === 'win' ? ZERO : `-${applied.progressReversed}`,
        balanceAfter: applied.balanceAfter,
        externalRoundId: args.externalRoundId,
      });
    }

    return { bonusShare: settled };
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

  private async roundStakes(
    tx: DrizzleTx,
    userId: Uuid,
    round: NonNullable<PromoGrantEntry['externalRoundId']>,
  ): Promise<RoundStake[]> {
    return tx
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
      .orderBy(asc(promoGrantEntry.grantId));
  }

  /** A round is reversed once. A second callback for it must not refund the stake again. */
  private async alreadyReversed(
    tx: DrizzleTx,
    round: NonNullable<PromoGrantEntry['externalRoundId']>,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: promoGrantEntry.id })
      .from(promoGrantEntry)
      .where(and(eq(promoGrantEntry.externalRoundId, round), eq(promoGrantEntry.type, 'reversal')))
      .limit(1);
    return row !== undefined;
  }

  /** A grant that already completed, expired or was forfeited takes no more money. */
  private async creditBonus(tx: DrizzleTx, grantId: PromoGrant['id'], amount: string) {
    const [row] = await tx
      .update(promoGrant)
      .set({ bonusBalance: sql`${promoGrant.bonusBalance} + ${amount}::numeric` })
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ? { balanceAfter: row.balanceAfter, progressReversed: ZERO } : null;
  }

  /**
   * A voided round returns the bonus stake and takes back the progress it bought, in proportion:
   * a partial void must not erase the whole round's contribution.
   */
  private async reverseRound(tx: DrizzleTx, stake: RoundStake, amount: string) {
    const progressReversed = moneyDivide(
      moneyScaleBy(stake.weightedTotal, amount),
      stake.bonusStake,
    );
    const [row] = await tx
      .update(promoGrant)
      .set({
        bonusBalance: sql`${promoGrant.bonusBalance} + ${amount}::numeric`,
        wageringProgress: sql`GREATEST(0, ${promoGrant.wageringProgress} - ${progressReversed}::numeric)`,
      })
      .where(and(eq(promoGrant.id, stake.grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ? { balanceAfter: row.balanceAfter, progressReversed } : null;
  }
}
