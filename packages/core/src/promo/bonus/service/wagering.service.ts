import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  /** Bonus funds of this round already returned to the grant by an earlier reversal. */
  bonusReturned: string;
  /** Real funds of this round already returned to the player by an earlier reversal. */
  realReturned: string;
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
    const reversal = args.kind === 'bet_reversal';

    // A reversal can only give back what the round still holds. A second rollback callback for a
    // round already returned in full finds nothing outstanding, and reporting its amount as the
    // player's own money would pay an un-wagered bonus stake out as withdrawable cash.
    const outstanding = stakes.map((stake) => ({
      stake,
      bonus: reversal ? moneySubtract(stake.bonusStake, stake.bonusReturned) : stake.bonusStake,
      real: reversal ? moneySubtract(stake.realStake, stake.realReturned) : stake.realStake,
    }));
    const totalBonus = outstanding.reduce((sum, row) => moneyAdd(sum, row.bonus), ZERO);
    const totalStake = outstanding.reduce((sum, row) => moneyAdd(sum, row.real), totalBonus);

    if (moneyCompare(totalBonus, ZERO) <= 0 || moneyCompare(totalStake, ZERO) <= 0) {
      // A round that drew no bonus at all settles entirely against the real balance. One whose
      // bonus part is already back on the grant settles against nothing.
      const drewBonus = stakes.some((stake) => moneyCompare(stake.bonusStake, ZERO) > 0);
      return { bonusShare: ZERO, realShare: reversal && drewBonus ? ZERO : args.amount };
    }

    // A rollback larger than what is outstanding is capped rather than trusted: the surplus is
    // not the player's money either.
    const applyAmount =
      reversal && moneyCompare(args.amount, totalStake) > 0 ? totalStake : args.amount;
    // Truncating, so a rounding remainder lands on the real balance rather than the bonus one.
    const share = moneyDivide(moneyScaleBy(applyAmount, totalBonus), totalStake);
    const totalReal = moneySubtract(totalStake, totalBonus);
    const realShare = moneySubtract(applyAmount, share);

    let settled = ZERO;
    let returned = ZERO;
    for (const [index, row] of outstanding.entries()) {
      const last = index === outstanding.length - 1;
      // Each grant takes the part of each share its own funding paid for; the last takes whatever
      // truncation left over, so the parts always add back up to the share.
      const slice = last
        ? moneySubtract(share, settled)
        : moneyDivide(moneyScaleBy(share, row.bonus), totalBonus);
      const realSlice =
        moneyCompare(totalReal, ZERO) <= 0
          ? ZERO
          : last
            ? moneySubtract(realShare, returned)
            : moneyDivide(moneyScaleBy(realShare, row.real), totalReal);
      if (moneyCompare(slice, ZERO) <= 0 && moneyCompare(realSlice, ZERO) <= 0) {
        continue;
      }

      const applied = reversal
        ? await this.reverseRound(tx, row.stake, slice)
        : await this.creditBonus(tx, row.stake.grantId, slice);
      if (applied === null) {
        // A win on a grant that has already completed belongs to the real balance: its bonus
        // funds converted at completion. A reversal does not - returning a bonus-funded stake as
        // real money releases it without the wagering it was granted under.
        if (reversal) {
          throw new GrantNotReversibleError();
        }
        continue;
      }
      settled = moneyAdd(settled, slice);
      returned = moneyAdd(returned, realSlice);

      await tx.insert(promoGrantEntry).values({
        grantId: row.stake.grantId,
        userId: args.userId,
        currency: args.currency,
        type: reversal ? 'reversal' : 'win',
        // Both movements put funds back on the grant, so both are a positive delta: a grant's
        // entries have to keep summing to the balance they explain.
        bonusAmount: slice,
        ...(reversal ? { realAmount: realSlice } : {}),
        wageringDelta: reversal ? `-${applied.progressReversed}` : ZERO,
        balanceAfter: applied.balanceAfter,
        externalRoundId: args.externalRoundId,
      });
    }

    return { bonusShare: settled, realShare: moneySubtract(applyAmount, settled) };
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
    // What the round took, and what earlier callbacks already gave back, in one pass: a second
    // rollback has to net against the first rather than be waved through or refused outright.
    const onStake = sql`${promoGrantEntry.type} = 'stake'`;
    const onReversal = sql`${promoGrantEntry.type} = 'reversal'`;
    return tx
      .select({
        grantId: promoGrantEntry.grantId,
        bonusStake: sql<string>`(-sum(case when ${onStake} then ${promoGrantEntry.bonusAmount} else 0 end))::text`,
        realStake: sql<string>`sum(case when ${onStake} then ${promoGrantEntry.realAmount} else 0 end)::text`,
        weightedTotal: sql<string>`sum(case when ${onStake} then ${promoGrantEntry.wageringDelta} else 0 end)::text`,
        bonusReturned: sql<string>`sum(case when ${onReversal} then ${promoGrantEntry.bonusAmount} else 0 end)::text`,
        realReturned: sql<string>`sum(case when ${onReversal} then ${promoGrantEntry.realAmount} else 0 end)::text`,
      })
      .from(promoGrantEntry)
      .where(
        and(
          eq(promoGrantEntry.userId, userId),
          eq(promoGrantEntry.externalRoundId, round),
          inArray(promoGrantEntry.type, ['stake', 'reversal']),
        ),
      )
      .groupBy(promoGrantEntry.grantId)
      .orderBy(asc(promoGrantEntry.grantId));
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
    // A grant that funded none of this round bought no progress with it, and the proportion below
    // would divide by its zero bonus stake.
    const progressReversed =
      moneyCompare(stake.bonusStake, ZERO) <= 0
        ? ZERO
        : moneyDivide(moneyScaleBy(stake.weightedTotal, amount), stake.bonusStake);
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
