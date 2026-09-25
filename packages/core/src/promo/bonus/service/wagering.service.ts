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
  moneyAdd,
  moneyCompare,
  moneyDivide,
  moneyScaleBy,
  moneySubtract,
  withAdvisoryXactLock,
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
 * What a completing grant is allowed to turn into real money. Absent multiplier means uncapped;
 * otherwise the ceiling is that multiple of what was originally granted, truncating, so the cap
 * is never rounded in the player's favour.
 */
function capConversion(
  balance: string,
  grantedAmount: string,
  maxWinMultiplier: string | null | undefined,
): string {
  if (maxWinMultiplier === null || maxWinMultiplier === undefined) {
    return balance;
  }
  const ceiling = moneyScaleBy(grantedAmount, maxWinMultiplier);
  return moneyCompare(balance, ceiling) < 0 ? balance : ceiling;
}

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
      if (moneyCompare(args.fromBonus, ZERO) > 0) {
        return { ok: false, reason: 'insufficient_bonus', bonusAvailable: ZERO };
      }
      // No bonus attributed to this bet: it is a plain real-money wager, still counted toward
      // rank and rank-adjacent tracking (streaks, etc) at its full stake - nothing here weights
      // it down the way a bonus's contribution percent would.
      await this.wagerTracking?.recordWager(tx, {
        userId: args.userId,
        currency: args.currency,
        amount: args.stake,
        weightedAmount: args.stake,
        realAmount: args.stake,
        context: args.context,
      });
      return {
        ok: true,
        grantId: null,
        bonusSpent: ZERO,
        weightedAmount: ZERO,
        bonusBalanceAfter: ZERO,
        completed: null,
      };
    }

    // Against the terms snapshot, inside the transaction that moves the money. It is an
    // anti-abuse control - a player who can stake the whole bonus on one spin turns a wagering
    // requirement into a coin flip - so a preflight read the client could skip is not enough.
    // It bounds the whole stake, not the bonus part: the limit applies while a bonus is active.
    const { maxBet } = grant.terms;
    if (maxBet !== null && maxBet !== undefined && moneyCompare(args.stake, maxBet) > 0) {
      return { ok: false, reason: 'max_bet_exceeded', maxBet };
    }

    const spent = await this.spendBonus(tx, grant.id, args.fromBonus);
    if (spent === null) {
      return { ok: false, reason: 'insufficient_bonus', bonusAvailable: grant.bonusBalance };
    }

    const percent = resolveContributionPercent(grant.terms.weights, args.context);
    const weighted = weightedStake(args.stake, percent);
    // The row is locked, so the progress read above is what the update starts from; the delta is
    // whatever the requirement still had room for.
    const headroom = moneySubtract(grant.wageringRequired, grant.wageringProgress);
    const applied = moneyCompare(weighted, headroom) < 0 ? weighted : headroom;
    const advanced = await this.advanceProgress(tx, grant.id, weighted);
    const completed = advanced?.status === 'completed';
    // The cap bites here, at the single point where bonus funds become real money, rather than
    // on every win along the way: what the terms limit is the payout, and winnings that are
    // still bonus can still be lost back. Anything above it dies with the grant.
    const convertedAmount = completed
      ? capConversion(spent.balanceAfter, grant.grantedAmount, grant.terms.maxWinMultiplier)
      : ZERO;
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
      providerName: args.providerName,
      externalRoundId: args.externalRoundId,
    });

    if (completed) {
      const capped = moneySubtract(spent.balanceAfter, convertedAmount);
      await tx.insert(promoGrantEntry).values({
        grantId: grant.id,
        userId: args.userId,
        currency: args.currency,
        type: 'convert',
        bonusAmount: `-${convertedAmount}`,
        balanceAfter: capped,
      });
      // What the cap took has to leave the ledger too, or a grant's entries stop summing to the
      // balance they explain and the surplus looks like money still owed to the player.
      if (moneyCompare(capped, ZERO) > 0) {
        await tx.insert(promoGrantEntry).values({
          grantId: grant.id,
          userId: args.userId,
          currency: args.currency,
          type: 'forfeit',
          bonusAmount: `-${capped}`,
          balanceAfter: ZERO,
        });
      }
    }

    await this.wagerTracking?.recordWager(tx, {
      userId: args.userId,
      currency: args.currency,
      amount: args.stake,
      weightedAmount: weighted,
      realAmount: moneySubtract(args.stake, args.fromBonus),
      context: args.context,
    });

    return {
      ok: true,
      grantId: grant.id,
      bonusSpent: args.fromBonus,
      weightedAmount: weighted,
      bonusBalanceAfter: balanceAfter,
      completed: completed ? { grantId: grant.id, convertedAmount } : null,
    };
  }

  async settle(tx: DrizzleTx, args: BonusSettleArgs): Promise<BonusSettleOutcome> {
    // Two settlement callbacks for the same round (a provider retrying a reversal under a
    // different reference, or a win racing a void) would otherwise both read the same
    // outstanding stake before either insert lands, and both give it back - the same stake
    // refunded twice. Locked for the rest of this call, released with the transaction.
    return withAdvisoryXactLock(
      tx,
      `promo-round-settle:${args.userId}:${args.providerName}:${args.currency}:${args.externalRoundId}`,
      () => this.settleLocked(tx, args),
    );
  }

  private async settleLocked(tx: DrizzleTx, args: BonusSettleArgs): Promise<BonusSettleOutcome> {
    const stakes = await this.roundStakes(
      tx,
      args.userId,
      args.currency,
      args.providerName,
      args.externalRoundId,
    );
    const reversal = args.kind === 'bet_reversal';

    if (stakes.length === 0) {
      // No grant was ever attributed to this round: a plain cash bet, nothing to reverse or
      // settle against a grant.
      return { bonusShare: ZERO, realShare: args.amount };
    }

    // Net against what an earlier callback for this round already gave back, on both branches: a
    // win reported after a round was already voided must not be split against the original 100%
    // stake as if the void had never happened, any more than a second reversal callback may.
    const outstanding = stakes.map((stake) => ({
      stake,
      bonus: moneySubtract(stake.bonusStake, stake.bonusReturned),
      real: moneySubtract(stake.realStake, stake.realReturned),
    }));
    const totalBonus = outstanding.reduce((sum, row) => moneyAdd(sum, row.bonus), ZERO);
    const totalReal = outstanding.reduce((sum, row) => moneyAdd(sum, row.real), ZERO);
    const totalStake = moneyAdd(totalBonus, totalReal);

    if (moneyCompare(totalStake, ZERO) <= 0) {
      // Already fully reversed by an earlier callback (or there was never anything to reverse):
      // nothing is outstanding for either balance.
      return { bonusShare: ZERO, realShare: ZERO };
    }

    // A rollback larger than what is outstanding is capped rather than trusted: the surplus is
    // not the player's money either.
    const applyAmount =
      reversal && moneyCompare(args.amount, totalStake) > 0 ? totalStake : args.amount;
    // Truncating, so a rounding remainder lands on the real balance rather than the bonus one.
    const share =
      moneyCompare(totalBonus, ZERO) <= 0
        ? ZERO
        : moneyDivide(moneyScaleBy(applyAmount, totalBonus), totalStake);
    const realShare = moneySubtract(applyAmount, share);

    let settled = ZERO;
    // What each row was actually assigned, whether or not its own attempt then succeeded. The
    // `last` row's remainder is computed against this, never against `settled`: a row that failed
    // still has to keep its assigned slice out of the next row's remainder, or the next row
    // silently absorbs it into a balance that never earned it.
    let allocated = ZERO;
    let realAllocated = ZERO;
    // A slice that could not go back onto its grant because the grant is no longer active, and
    // that grant did not complete (it expired or was forfeited). The default takes the winnings,
    // or the voided stake, from that bonus along with the bonus balance itself, so this slice
    // belongs to neither balance - it is not added to realShare below.
    let forfeited = ZERO;
    for (const [index, row] of outstanding.entries()) {
      const last = index === outstanding.length - 1;
      // Each grant takes the part of each share its own funding paid for; the last takes whatever
      // truncation left over, so the parts always add back up to the share.
      const slice = last
        ? moneySubtract(share, allocated)
        : moneyDivide(moneyScaleBy(share, row.bonus), totalBonus);
      const realSlice =
        moneyCompare(totalReal, ZERO) <= 0
          ? ZERO
          : last
            ? moneySubtract(realShare, realAllocated)
            : moneyDivide(moneyScaleBy(realShare, row.real), totalReal);
      allocated = moneyAdd(allocated, slice);
      realAllocated = moneyAdd(realAllocated, realSlice);
      if (moneyCompare(slice, ZERO) <= 0 && moneyCompare(realSlice, ZERO) <= 0) {
        continue;
      }

      const applied = reversal
        ? await this.reverseRound(tx, row.stake, slice, realSlice)
        : await this.creditBonus(tx, row.stake.grantId, slice);
      if (applied === null) {
        // Neither `creditBonus` nor `reverseRound` touches a grant that has left 'active': a
        // completed grant's bonus funds already converted to real money at completion, so its
        // slice falls through to the real balance below exactly like a win's does. An expired or
        // forfeited grant took the slice with it when it closed, on a reversal exactly as much as
        // on a win - returning a bonus-funded stake or win as real money would release value the
        // wagering it required never earned.
        const status = await this.grantStatus(tx, row.stake.grantId);
        if (status !== 'completed') {
          forfeited = moneyAdd(forfeited, slice);
          // The wallet's own ledger already recorded the full gross amount for this callback; if
          // this grant's slice is not visible here too, the gap between what the provider
          // reported and what either balance received is recorded nowhere.
          await tx.insert(promoGrantEntry).values({
            grantId: row.stake.grantId,
            userId: args.userId,
            currency: args.currency,
            type: 'forfeit',
            bonusAmount: ZERO,
            realAmount: slice,
            balanceAfter: await this.grantBalance(tx, row.stake.grantId),
            providerName: args.providerName,
            externalRoundId: args.externalRoundId,
          });
        }
        continue;
      }
      settled = moneyAdd(settled, slice);

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
        providerName: args.providerName,
        externalRoundId: args.externalRoundId,
      });
    }

    // Clamped at zero as a backstop: `settled` and `forfeited` are bounded by construction to
    // never exceed `applyAmount` between them, but a floor holds even if that ever drifts, rather
    // than a negative share reaching `creditWalletBalance` and debiting the player's real balance
    // for a win.
    const realShareOut = moneySubtract(moneySubtract(applyAmount, settled), forfeited);
    return {
      bonusShare: settled,
      realShare: moneyCompare(realShareOut, ZERO) < 0 ? ZERO : realShareOut,
    };
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
        grantedAmount: promoGrant.grantedAmount,
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
    currency: string,
    providerName: string,
    round: NonNullable<PromoGrantEntry['externalRoundId']>,
  ): Promise<RoundStake[]> {
    // What the round took, and what earlier callbacks already gave back, in one pass: a second
    // rollback has to net against the first rather than be waved through or refused outright.
    // Currency and provider qualify the round id, so a different provider or currency minting
    // the same id independently can never net against this one.
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
          eq(promoGrantEntry.currency, currency),
          eq(promoGrantEntry.providerName, providerName),
          eq(promoGrantEntry.externalRoundId, round),
          inArray(promoGrantEntry.type, ['stake', 'reversal']),
        ),
      )
      .groupBy(promoGrantEntry.grantId)
      .orderBy(asc(promoGrantEntry.grantId));
  }

  /** Read after `creditBonus`/`reverseRound` refuses, to tell a completed grant apart from a terminal one. */
  private async grantStatus(tx: DrizzleTx, grantId: PromoGrant['id']) {
    const [row] = await tx
      .select({ status: promoGrant.status })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    return row?.status ?? null;
  }

  /** The grant's current bonus balance, for a ledger row that records a movement with no delta. */
  private async grantBalance(tx: DrizzleTx, grantId: PromoGrant['id']) {
    const [row] = await tx
      .select({ bonusBalance: promoGrant.bonusBalance })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    return row?.bonusBalance ?? ZERO;
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
   * a partial void must not erase the whole round's contribution. The proportion is taken against
   * the round's whole stake, bonus and real together - `wager()` weights and counts the full
   * stake regardless of which balance paid it, so a cash-funded bet under an active grant still
   * advanced progress, and a void of it still has to take that progress back.
   */
  private async reverseRound(
    tx: DrizzleTx,
    stake: RoundStake,
    bonusAmount: string,
    realAmount: string,
  ) {
    const totalStake = moneyAdd(stake.bonusStake, stake.realStake);
    const progressReversed =
      moneyCompare(totalStake, ZERO) <= 0
        ? ZERO
        : moneyDivide(
            moneyScaleBy(stake.weightedTotal, moneyAdd(bonusAmount, realAmount)),
            totalStake,
          );
    const [row] = await tx
      .update(promoGrant)
      .set({
        bonusBalance: sql`${promoGrant.bonusBalance} + ${bonusAmount}::numeric`,
        wageringProgress: sql`GREATEST(0, ${promoGrant.wageringProgress} - ${progressReversed}::numeric)`,
      })
      .where(and(eq(promoGrant.id, stake.grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ? { balanceAfter: row.balanceAfter, progressReversed } : null;
  }
}
