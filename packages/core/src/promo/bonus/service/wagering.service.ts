import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type AuditWritePort,
  type BonusFreeFundsOrder,
  type BonusCloseRoundArgs,
  type BonusCompletion,
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
  promoGrantRound,
  type PromoGrant,
  type PromoGrantEntry,
} from '../schema/index.js';
import { isRealMoneyOnlyProduct } from '../contract/index.js';
import { attributeStake } from '../shared/stake-attribution.js';
import { resolveContributionPercent, weightedStake } from '../shared/wagering-weight.js';
import {
  DEFAULT_FUND_SETTINGS,
  clampCounters,
  isDepleted,
  splitAcross,
  type FundSplit,
} from '../shared/fund-buckets.js';

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

type RoundKey = Pick<
  BonusCloseRoundArgs,
  'userId' | 'currency' | 'providerName' | 'externalRoundId'
>;

const isPositive = (amount: string) => moneyCompare(amount, ZERO) > 0;

type RoundStake = {
  grantId: PromoGrant['id'];
  bonusStake: string;
  realStake: string;
  unlinkedStake: string;
  linkedStake: string;
  weightedTotal: string;
  /** Funds of this round already returned by an earlier reversal, per bucket. */
  bonusReturned: string;
  realReturned: string;
  unlinkedReturned: string;
  linkedReturned: string;
};

/**
 * The wagering engine: how a bet splits across free real money and the grants' buckets, what it
 * does to each requirement, and how a win, refund or loss settles back.
 *
 * Bound to the sealed BONUS_WAGERING token and always called on the wallet's own transaction,
 * below its duplicate-provider-reference guard, so a replayed wager can never reach it.
 *
 * It never calls back into the wallet. A completed grant is reported as `convertedAmount` and the
 * wallet, which already holds the transaction, performs the credit.
 */
export class WageringService implements BonusWageringCommands {
  constructor(
    private readonly audit: AuditWritePort,
    private readonly wagerTracking?: WagerTrackingCommands,
  ) {}

  async wager(tx: DrizzleTx, args: BonusWagerArgs): Promise<BonusWagerOutcome> {
    const realOnly = isRealMoneyOnlyProduct(args.context.product);
    const locked = await this.lockLiveGrants(tx, args.userId, args.currency);
    const round = { providerName: args.providerName, externalRoundId: args.externalRoundId };
    const grants = locked.map((grant) => planGrant(grant, args, realOnly));
    const [primary] = grants;

    if (!primary) {
      if (moneyCompare(args.stake, args.realAvailable) > 0) {
        return { ok: false, reason: 'insufficient_bonus', bonusAvailable: ZERO };
      }
      return this.unattributed(tx, args);
    }

    // Against the terms snapshots, inside the transaction that moves the money. It is an
    // anti-abuse control - a player who can stake the whole bonus on one spin turns a wagering
    // requirement into a coin flip - so a preflight read the client could skip is not enough.
    // It bounds the whole stake, not the bonus part, and the round's total rather than one debit:
    // splitting a stake across debits of one round must not get around it. While several grants
    // are active the strictest limit among those that do not exempt the product applies. A
    // product that never touches bonus funds or progress is outside it.
    const maxBet = realOnly ? null : strictestMaxBet(locked, args.context.product);
    if (maxBet !== null && isPositive(args.stake)) {
      const roundStake = moneyAdd(await this.outstandingRoundStake(tx, args), args.stake);
      if (moneyCompare(roundStake, maxBet) > 0) {
        return { ok: false, reason: 'max_bet_exceeded', maxBet, roundStake };
      }
    }

    // A and B of every grant are claims on the same real balance, so they are clamped against it
    // in rollover order; what no grant names is free real money.
    let realLeft = isPositive(args.realAvailable) ? args.realAvailable : ZERO;
    const counters = grants.map(({ grant }) => {
      const clamped = clampCounters({
        real: realLeft,
        unlinked: grant.unlinkedCash,
        linked: grant.linkedCash,
      });
      realLeft = moneySubtract(realLeft, moneyAdd(clamped.unlinked, clamped.linked));
      return clamped;
    });

    const spent = splitAcrossGrants({
      stake: args.stake,
      free: realLeft,
      grants: grants.map((plan, i) => ({
        available: {
          unlinked: counters[i]?.unlinked ?? ZERO,
          linked: counters[i]?.linked ?? ZERO,
          bonus: plan.grant.bonusBalance,
        },
        bonusAllowed: plan.bonusAllowed,
      })),
      order: primary.settings.freeFundsOrder,
    });
    if (spent === null) {
      const bonusAvailable = grants
        .filter((plan) => plan.bonusAllowed)
        .reduce((sum, plan) => moneyAdd(sum, plan.grant.bonusBalance), ZERO);
      return { ok: false, reason: 'insufficient_bonus', bonusAvailable };
    }

    // Each grant's own buckets progress that grant alone; free real money fills the requirements
    // in rollover order. Progress is capped at each grant's room and never completes a grant here:
    // completion waits for the round to close.
    const attribution = attributeStake(
      grants.map((plan, i) => {
        const own = spent.grants[i] ?? EMPTY_GRANT_SPEND;
        const room = moneySubtract(plan.grant.wageringRequired, plan.grant.wageringProgress);
        return {
          id: plan.grant.id,
          headroom: isPositive(room) ? room : ZERO,
          percent: plan.percent,
          bonusStake: sumOf(own.bonus, sumOf(own.unlinked, own.linked)),
        };
      }),
      spent.free,
    );

    const ownTotal = attribution.reduce((sum, share) => moneyAdd(sum, share.bonusStake), ZERO);
    const progressTotal = attribution.reduce((sum, share) => moneyAdd(sum, share.progress), ZERO);
    if (!isPositive(ownTotal) && !isPositive(progressTotal)) {
      return this.unattributed(tx, args);
    }

    const balanceAfter = new Map(grants.map(({ grant }) => [grant.id, grant.bonusBalance]));
    let attributedTo: PromoGrant['id'] | null = null;
    let bonusSpent = ZERO;
    let weightedAmount = ZERO;
    for (const [i, share] of attribution.entries()) {
      const plan = grants[i];
      if (!plan) {
        continue;
      }
      const own = spent.grants[i] ?? EMPTY_GRANT_SPEND;
      weightedAmount = sumOf(
        weightedAmount,
        weightedStake(sumOf(share.bonusStake, share.realStake), plan.percent),
      );
      const touched =
        isPositive(share.bonusStake) || isPositive(share.realStake) || isPositive(share.progress);
      if (!touched) {
        continue;
      }
      const after = await this.spend(
        tx,
        plan.grant.id,
        { free: ZERO, ...own },
        counters[i] ?? EMPTY_COUNTERS,
      );
      if (after === null) {
        // The row is locked and its balance was read under that lock, so this cannot happen.
        throw new Error(`bonus grant ${plan.grant.id} refused a stake it was locked to cover`);
      }
      if (isPositive(share.progress)) {
        await this.advanceProgress(tx, plan.grant.id, share.progress);
      }
      balanceAfter.set(plan.grant.id, after.balanceAfter);
      bonusSpent = sumOf(bonusSpent, own.bonus);
      attributedTo ??= plan.grant.id;

      await tx.insert(promoGrantEntry).values({
        grantId: plan.grant.id,
        userId: args.userId,
        currency: args.currency,
        type: 'stake',
        bonusAmount: `-${own.bonus}`,
        realAmount: sumOf(share.realStake, sumOf(own.unlinked, own.linked)),
        unlinkedAmount: own.unlinked,
        linkedAmount: own.linked,
        wageringDelta: share.progress,
        balanceAfter: after.balanceAfter,
        ...round,
      });
      await this.openRound(tx, plan.grant.id, args);
    }

    const walletCredits =
      (await this.wagerTracking?.recordWager(tx, {
        userId: args.userId,
        currency: args.currency,
        amount: args.stake,
        weightedAmount: realOnly ? args.stake : weightedAmount,
        realAmount: moneySubtract(args.stake, bonusSpent),
        context: args.context,
        round,
      })) ?? [];

    return {
      ok: true,
      grantId: attributedTo,
      bonusSpent,
      weightedAmount: realOnly ? ZERO : weightedAmount,
      bonusBalanceAfter: [...balanceAfter.values()].reduce(sumOf, ZERO),
      walletCredits,
    };
  }

  /**
   * A plain real-money wager, still counted toward rank and rank-adjacent tracking (streaks, etc)
   * at its full stake - nothing here weights it down the way a bonus's contribution percent would.
   */
  private async unattributed(tx: DrizzleTx, args: BonusWagerArgs): Promise<BonusWagerOutcome> {
    const walletCredits =
      (await this.wagerTracking?.recordWager(tx, {
        userId: args.userId,
        currency: args.currency,
        amount: args.stake,
        weightedAmount: args.stake,
        realAmount: args.stake,
        context: args.context,
        round: { providerName: args.providerName, externalRoundId: args.externalRoundId },
      })) ?? [];
    return {
      ok: true,
      grantId: null,
      bonusSpent: ZERO,
      weightedAmount: ZERO,
      bonusBalanceAfter: ZERO,
      walletCredits,
    };
  }

  async settle(tx: DrizzleTx, args: BonusSettleArgs): Promise<BonusSettleOutcome> {
    // Two settlement callbacks for the same round (a provider retrying a reversal under a
    // different reference, or a win racing a void) would otherwise both read the same
    // outstanding stake before either insert lands, and both give it back - the same stake
    // refunded twice. Locked for the rest of this call, released with the transaction.
    return withAdvisoryXactLock(tx, roundLockKey(args), () => this.settleLocked(tx, args));
  }

  async closeRound(
    tx: DrizzleTx,
    args: BonusCloseRoundArgs,
  ): Promise<{ completed: BonusCompletion[] }> {
    return withAdvisoryXactLock(tx, roundLockKey(args), async () => {
      const grantIds = await this.settleRound(tx, args);
      return { completed: await this.resolveAll(tx, grantIds, args.realBalance) };
    });
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
      // settle against a grant - but whatever it counted toward outside the bonus still is.
      if (reversal) {
        await this.reverseTracking(tx, args, args.amount);
      }
      return { bonusShare: ZERO, realShare: args.amount, completed: [] };
    }

    // Net against what an earlier callback for this round already gave back, on both branches: a
    // win reported after a round was already voided must not be split against the original stake
    // as if the void had never happened, any more than a second reversal callback may.
    const outstanding = stakes.map((stake) => outstandingOf(stake));
    const totalStake = outstanding.reduce(
      (sum, row) => moneyAdd(sum, moneyAdd(row.bonus, row.realTotal)),
      ZERO,
    );

    if (!isPositive(totalStake)) {
      // Already fully reversed by an earlier callback: nothing is outstanding for either balance.
      await this.settleRound(tx, args);
      return { bonusShare: ZERO, realShare: ZERO, completed: [] };
    }

    // A rollback larger than what is outstanding is capped rather than trusted: the surplus is
    // not the player's money either.
    const applyAmount =
      reversal && moneyCompare(args.amount, totalStake) > 0 ? totalStake : args.amount;
    // Every grant's every bucket is one pot, listed most restricted first so the rounding residue
    // lands on bonus funds before it can reach a freer bucket.
    const count = outstanding.length;
    const pots = [
      ...outstanding.map((row) => row.bonus),
      ...outstanding.map((row) => row.linked),
      ...outstanding.map((row) => row.unlinked),
      ...outstanding.map((row) => row.free),
    ];
    const shares = splitAcross(applyAmount, pots) ?? pots.map(() => ZERO);
    const share = (i: number) => shares[i] ?? ZERO;
    const slices = outstanding.map((row, i) => ({
      row,
      slice: {
        bonus: share(i),
        linked: share(count + i),
        unlinked: share(2 * count + i),
        free: share(3 * count + i),
      },
    }));
    const realReturned = slices.reduce(
      (sum, { slice }) =>
        moneyAdd(sum, moneyAdd(slice.free, moneyAdd(slice.unlinked, slice.linked))),
      ZERO,
    );
    if (reversal) {
      // The bonus-funded share never counted toward tracking (`recordWager` takes `realAmount`),
      // so only the real share is taken back out of it.
      await this.reverseTracking(tx, args, realReturned);
    }

    let settled = ZERO;
    // A slice that could not go back onto its grant because the grant is no longer active, and
    // that grant did not complete (it expired, was forfeited or depleted). The default takes the
    // winnings, or the voided stake, from that bonus along with the bonus balance itself, so this
    // slice belongs to neither balance - it is not added to realShare below.
    let forfeited = ZERO;
    for (const { row, slice } of slices) {
      const realSlice = moneyAdd(slice.free, moneyAdd(slice.unlinked, slice.linked));
      if (!isPositive(slice.bonus) && !isPositive(realSlice)) {
        continue;
      }

      const applied = reversal
        ? await this.reverseRound(tx, row.stake, slice)
        : await this.creditBonus(tx, row.stake.grantId, slice);
      if (applied === null) {
        // A completed grant's bonus funds already converted at completion, so its slice falls
        // through to the real balance like a win's does. An expired, forfeited or depleted grant
        // took the slice with it when it closed - returning a bonus-funded stake or win as real
        // money would release value the wagering it required never earned.
        const status = await this.grantStatus(tx, row.stake.grantId);
        if (status !== 'completed' && isPositive(slice.bonus)) {
          forfeited = moneyAdd(forfeited, slice.bonus);
          // The wallet's own ledger already recorded the full gross amount for this callback; if
          // this grant's slice is not visible here too, the gap between what the provider
          // reported and what either balance received is recorded nowhere.
          await tx.insert(promoGrantEntry).values({
            grantId: row.stake.grantId,
            userId: args.userId,
            currency: args.currency,
            type: 'forfeit',
            bonusAmount: ZERO,
            realAmount: slice.bonus,
            balanceAfter: await this.grantBalance(tx, row.stake.grantId),
            providerName: args.providerName,
            externalRoundId: args.externalRoundId,
          });
        }
        continue;
      }
      settled = moneyAdd(settled, slice.bonus);

      await tx.insert(promoGrantEntry).values({
        grantId: row.stake.grantId,
        userId: args.userId,
        currency: args.currency,
        type: reversal ? 'reversal' : 'win',
        // Both movements put funds back on the grant, so both are a positive delta: a grant's
        // entries have to keep summing to the balance they explain.
        bonusAmount: slice.bonus,
        realAmount: realSlice,
        unlinkedAmount: slice.unlinked,
        linkedAmount: slice.linked,
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
    const realShare = isPositive(realShareOut) ? realShareOut : ZERO;

    if (!args.final && !(reversal && moneyCompare(applyAmount, totalStake) >= 0)) {
      return { bonusShare: settled, realShare, completed: [] };
    }
    const grantIds = await this.settleRound(tx, args);
    const completed = await this.resolveAll(tx, grantIds, moneyAdd(args.realBalance, realShare));
    return { bonusShare: settled, realShare, completed };
  }

  private async reverseTracking(tx: DrizzleTx, args: BonusSettleArgs, realAmount: string) {
    if (!isPositive(realAmount)) {
      return;
    }
    await this.wagerTracking?.reverseWager?.(tx, {
      userId: args.userId,
      currency: args.currency,
      round: { providerName: args.providerName, externalRoundId: args.externalRoundId },
      realAmount,
    });
  }

  /** What the round already staked on any grant, net of what reversals gave back. */
  private async outstandingRoundStake(tx: DrizzleTx, args: BonusWagerArgs): Promise<string> {
    const rows = await this.roundStakes(
      tx,
      args.userId,
      args.currency,
      args.providerName,
      args.externalRoundId,
    );
    return rows.reduce(
      (sum, row) =>
        moneyAdd(
          sum,
          moneySubtract(
            moneyAdd(row.bonusStake, row.realStake),
            moneyAdd(row.bonusReturned, row.realReturned),
          ),
        ),
      ZERO,
    );
  }

  /**
   * Every active grant held in the bet's own currency, in rollover order: earliest expiry first.
   * Locked in id order, the order settlement takes them in, so a stake and a settlement on two
   * shared grants cannot deadlock; the rollover order is applied after.
   */
  private async lockLiveGrants(tx: DrizzleTx, userId: Uuid, currency: string) {
    const rows = await tx
      .select({
        id: promoGrant.id,
        grantedAmount: promoGrant.grantedAmount,
        bonusBalance: promoGrant.bonusBalance,
        unlinkedCash: promoGrant.unlinkedCash,
        linkedCash: promoGrant.linkedCash,
        wageringRequired: promoGrant.wageringRequired,
        wageringProgress: promoGrant.wageringProgress,
        terms: promoGrant.terms,
        expiresAt: promoGrant.expiresAt,
        createdAt: promoGrant.createdAt,
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
      .orderBy(asc(promoGrant.id))
      .for('update');
    return rows.sort(
      (a, b) =>
        a.expiresAt.getTime() - b.expiresAt.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /**
   * Conditional in SQL, so two concurrent bets cannot both pass a balance they then overdraw. The
   * counters are written from their clamped value: whatever real money left the wallet outside a
   * bet stops being tied to the grant here.
   */
  private async spend(
    tx: DrizzleTx,
    grantId: PromoGrant['id'],
    split: FundSplit,
    counters: { unlinked: string; linked: string },
  ) {
    const [row] = await tx
      .update(promoGrant)
      .set({
        bonusBalance: sql`${promoGrant.bonusBalance} - ${split.bonus}::numeric`,
        unlinkedCash: moneySubtract(counters.unlinked, split.unlinked),
        linkedCash: moneySubtract(counters.linked, split.linked),
      })
      .where(
        and(
          eq(promoGrant.id, grantId),
          sql`${promoGrant.bonusBalance} >= ${split.bonus}::numeric`,
          eq(promoGrant.status, 'active'),
        ),
      )
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ?? null;
  }

  /** Capped, never completing: completion waits until no bet of the grant is still open. */
  private async advanceProgress(tx: DrizzleTx, grantId: PromoGrant['id'], weighted: string) {
    await tx
      .update(promoGrant)
      .set({
        wageringProgress: sql`LEAST(${promoGrant.wageringRequired}, ${promoGrant.wageringProgress} + ${weighted}::numeric)`,
      })
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')));
  }

  /** A second stake on a round already settled opens it again. */
  private async openRound(tx: DrizzleTx, grantId: PromoGrant['id'], args: BonusWagerArgs) {
    await tx
      .insert(promoGrantRound)
      .values({
        grantId,
        userId: args.userId,
        currency: args.currency,
        providerName: args.providerName,
        externalRoundId: args.externalRoundId,
      })
      .onConflictDoUpdate({
        target: [
          promoGrantRound.grantId,
          promoGrantRound.providerName,
          promoGrantRound.externalRoundId,
        ],
        set: { settledAt: null },
      });
  }

  /** Closes the round on every grant it was open on, and names those grants. */
  private async settleRound(tx: DrizzleTx, args: RoundKey): Promise<PromoGrant['id'][]> {
    const rows = await tx
      .update(promoGrantRound)
      .set({ settledAt: sql`now()` })
      .where(
        and(
          eq(promoGrantRound.userId, args.userId),
          eq(promoGrantRound.currency, args.currency),
          eq(promoGrantRound.providerName, args.providerName),
          eq(promoGrantRound.externalRoundId, args.externalRoundId),
          isNull(promoGrantRound.settledAt),
        ),
      )
      .returning({ grantId: promoGrantRound.grantId });
    return [...new Set(rows.map((row) => row.grantId))].sort();
  }

  private async resolveAll(
    tx: DrizzleTx,
    grantIds: PromoGrant['id'][],
    realBalance: string,
  ): Promise<BonusCompletion[]> {
    const completed: BonusCompletion[] = [];
    for (const grantId of grantIds) {
      const outcome = await this.resolveIdle(tx, grantId, realBalance);
      if (outcome !== null) {
        completed.push(outcome);
      }
    }
    return completed;
  }

  /**
   * A grant with no bet left open either completes (requirement met), depletes (every bucket
   * below the dust threshold) or carries on. Run after each settlement, under the grant's lock.
   */
  private async resolveIdle(
    tx: DrizzleTx,
    grantId: PromoGrant['id'],
    realBalance: string,
  ): Promise<BonusCompletion | null> {
    const [grant] = await tx
      .select()
      .from(promoGrant)
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .for('update');
    if (!grant) {
      return null;
    }
    const [open] = await tx
      .select({ id: promoGrantRound.id })
      .from(promoGrantRound)
      .where(and(eq(promoGrantRound.grantId, grantId), isNull(promoGrantRound.settledAt)))
      .limit(1);
    if (open) {
      return null;
    }

    if (moneyCompare(grant.wageringProgress, grant.wageringRequired) >= 0) {
      return this.complete(tx, grant);
    }

    const counters = clampCounters({
      real: realBalance,
      unlinked: grant.unlinkedCash,
      linked: grant.linkedCash,
    });
    const total = moneyAdd(grant.bonusBalance, moneyAdd(counters.unlinked, counters.linked));
    if (isDepleted(total, grant.terms.dustThreshold ?? ZERO)) {
      await this.deplete(tx, grant, total);
    }
    return null;
  }

  private async complete(tx: DrizzleTx, grant: PromoGrant): Promise<BonusCompletion> {
    // The cap bites here, at the single point where bonus funds become real money, rather than
    // on every win along the way: what the terms limit is the payout, and winnings that are
    // still bonus can still be lost back. Anything above it dies with the grant.
    const convertedAmount = capConversion(
      grant.bonusBalance,
      grant.grantedAmount,
      grant.terms.maxWinMultiplier,
    );
    await tx
      .update(promoGrant)
      .set({
        status: 'completed',
        bonusBalance: ZERO,
        unlinkedCash: ZERO,
        linkedCash: ZERO,
        closedAt: sql`now()`,
      })
      .where(eq(promoGrant.id, grant.id));

    const capped = moneySubtract(grant.bonusBalance, convertedAmount);
    await tx.insert(promoGrantEntry).values({
      grantId: grant.id,
      userId: grant.userId,
      currency: grant.currency,
      type: 'convert',
      bonusAmount: `-${convertedAmount}`,
      balanceAfter: capped,
    });
    // What the cap took has to leave the ledger too, or a grant's entries stop summing to the
    // balance they explain and the surplus looks like money still owed to the player.
    if (isPositive(capped)) {
      await tx.insert(promoGrantEntry).values({
        grantId: grant.id,
        userId: grant.userId,
        currency: grant.currency,
        type: 'forfeit',
        bonusAmount: `-${capped}`,
        balanceAfter: ZERO,
      });
    }
    return { grantId: grant.id, convertedAmount };
  }

  private async deplete(tx: DrizzleTx, grant: PromoGrant, total: string) {
    await tx
      .update(promoGrant)
      .set({
        status: 'depleted',
        bonusBalance: ZERO,
        unlinkedCash: ZERO,
        linkedCash: ZERO,
        closedAt: sql`now()`,
      })
      .where(eq(promoGrant.id, grant.id));
    if (isPositive(grant.bonusBalance)) {
      await tx.insert(promoGrantEntry).values({
        grantId: grant.id,
        userId: grant.userId,
        currency: grant.currency,
        type: 'forfeit',
        bonusAmount: `-${grant.bonusBalance}`,
        balanceAfter: ZERO,
      });
    }
    await this.audit.recordInTransaction(tx, {
      actorType: 'system',
      action: 'promo.bonus.depleted',
      resourceType: 'promo_grant',
      resourceId: grant.id,
      before: {
        status: grant.status,
        bonusBalance: grant.bonusBalance,
        linkedCash: grant.linkedCash,
        unlinkedCash: grant.unlinkedCash,
        wageringProgress: grant.wageringProgress,
      },
      after: {
        userId: grant.userId,
        status: 'depleted',
        remaining: total,
        dustThreshold: grant.terms.dustThreshold ?? ZERO,
      },
    });
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
    const total = (
      when: typeof onStake,
      column: (typeof promoGrantEntry)[
        | 'realAmount'
        | 'unlinkedAmount'
        | 'linkedAmount'
        | 'wageringDelta'
        | 'bonusAmount'],
    ) => sql<string>`sum(case when ${when} then ${column} else 0 end)::text`;
    return tx
      .select({
        grantId: promoGrantEntry.grantId,
        bonusStake: sql<string>`(-sum(case when ${onStake} then ${promoGrantEntry.bonusAmount} else 0 end))::text`,
        realStake: total(onStake, promoGrantEntry.realAmount),
        unlinkedStake: total(onStake, promoGrantEntry.unlinkedAmount),
        linkedStake: total(onStake, promoGrantEntry.linkedAmount),
        weightedTotal: total(onStake, promoGrantEntry.wageringDelta),
        bonusReturned: total(onReversal, promoGrantEntry.bonusAmount),
        realReturned: total(onReversal, promoGrantEntry.realAmount),
        unlinkedReturned: total(onReversal, promoGrantEntry.unlinkedAmount),
        linkedReturned: total(onReversal, promoGrantEntry.linkedAmount),
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
  private async creditBonus(tx: DrizzleTx, grantId: PromoGrant['id'], slice: FundSplit) {
    const [row] = await tx
      .update(promoGrant)
      .set(returnTo(slice))
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ? { balanceAfter: row.balanceAfter, progressReversed: ZERO } : null;
  }

  /**
   * A voided round returns its stake to the buckets it came from and takes back the progress it
   * bought, in proportion: a partial void must not erase the whole round's contribution. The
   * proportion is taken against the round's whole stake - `wager()` weights the full stake
   * regardless of which bucket paid it, so a void of a cash-funded bet still takes progress back.
   */
  private async reverseRound(tx: DrizzleTx, stake: RoundStake, slice: FundSplit) {
    const totalStake = moneyAdd(stake.bonusStake, stake.realStake);
    const returned = moneyAdd(
      moneyAdd(slice.bonus, slice.free),
      moneyAdd(slice.unlinked, slice.linked),
    );
    const progressReversed = isPositive(totalStake)
      ? moneyDivide(moneyScaleBy(stake.weightedTotal, returned), totalStake)
      : ZERO;
    const [row] = await tx
      .update(promoGrant)
      .set({
        ...returnTo(slice),
        wageringProgress: sql`GREATEST(0, ${promoGrant.wageringProgress} - ${progressReversed}::numeric)`,
      })
      .where(and(eq(promoGrant.id, stake.grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ? { balanceAfter: row.balanceAfter, progressReversed } : null;
  }
}

function roundLockKey(args: RoundKey) {
  return `promo-round-settle:${args.userId}:${args.providerName}:${args.currency}:${args.externalRoundId}`;
}

function outstandingOf(stake: RoundStake) {
  const unlinked = moneySubtract(stake.unlinkedStake, stake.unlinkedReturned);
  const linked = moneySubtract(stake.linkedStake, stake.linkedReturned);
  const realTotal = moneySubtract(stake.realStake, stake.realReturned);
  const free = moneySubtract(realTotal, moneyAdd(unlinked, linked));
  return {
    stake,
    bonus: moneySubtract(stake.bonusStake, stake.bonusReturned),
    unlinked,
    linked,
    free: isPositive(free) ? free : ZERO,
    realTotal,
  };
}

function returnTo(slice: FundSplit) {
  return {
    bonusBalance: sql`${promoGrant.bonusBalance} + ${slice.bonus}::numeric`,
    unlinkedCash: sql`${promoGrant.unlinkedCash} + ${slice.unlinked}::numeric`,
    linkedCash: sql`${promoGrant.linkedCash} + ${slice.linked}::numeric`,
  };
}

type LiveGrant = Pick<
  PromoGrant,
  | 'id'
  | 'grantedAmount'
  | 'bonusBalance'
  | 'unlinkedCash'
  | 'linkedCash'
  | 'wageringRequired'
  | 'wageringProgress'
  | 'terms'
  | 'expiresAt'
  | 'createdAt'
>;

type GrantSpend = Omit<FundSplit, 'free'>;

const EMPTY_GRANT_SPEND: GrantSpend = { unlinked: ZERO, linked: ZERO, bonus: ZERO };

const EMPTY_COUNTERS = { unlinked: ZERO, linked: ZERO };

/** Within one grant, the cash it ties up goes before its bonus funds. */
const GRANT_SPEND_ORDER = ['unlinked', 'linked', 'bonus'] as const;

/** How one grant treats this bet: its weight, its fund settings, and whether C may pay. */
function planGrant(grant: LiveGrant, args: BonusWagerArgs, realOnly: boolean) {
  const excluded = grant.terms.excludedProducts?.includes(args.context.product) === true;
  return {
    grant,
    settings: grant.terms.funds ?? DEFAULT_FUND_SETTINGS,
    bonusAllowed: !realOnly && !excluded,
    percent: realOnly ? ZERO : resolveContributionPercent(grant.terms.weights, args.context),
  };
}

/** A sum that keeps a lone non-zero term as written, so a one-grant bet reports amounts as given. */
function sumOf(a: string, b: string): string {
  if (moneyCompare(a, ZERO) === 0) {
    return b;
  }
  if (moneyCompare(b, ZERO) === 0) {
    return a;
  }
  return moneyAdd(a, b);
}

/** The lowest `maxBet` among the grants that do not exempt `product`, or null when none sets one. */
function strictestMaxBet(
  grants: readonly LiveGrant[],
  product: BonusWagerArgs['context']['product'],
): string | null {
  return grants.reduce<string | null>((strictest, { terms }) => {
    const { maxBet, maxBetExemptProducts } = terms;
    if (maxBet === null || maxBet === undefined || maxBetExemptProducts?.includes(product)) {
      return strictest;
    }
    return strictest === null || moneyCompare(maxBet, strictest) < 0 ? maxBet : strictest;
  }, null);
}

/**
 * The stake taken from free real money and from each grant's own buckets, grants in rollover
 * order and each grant's buckets A, B, C. Free money goes first or last as the primary grant's
 * `freeFundsOrder` says. Null when everything the bet may use falls short.
 */
function splitAcrossGrants(args: {
  stake: string;
  free: string;
  grants: readonly { available: GrantSpend; bonusAllowed: boolean }[];
  order: BonusFreeFundsOrder;
}): { free: string; grants: GrantSpend[] } | null {
  let remaining = args.stake;
  const take = (available: string) => {
    const taken = moneyCompare(remaining, available) <= 0 ? remaining : available;
    if (!isPositive(taken)) {
      return ZERO;
    }
    remaining = moneySubtract(remaining, taken);
    return taken;
  };
  const fromFree = args.order === 'first' ? take(args.free) : ZERO;
  const grants = args.grants.map(({ available, bonusAllowed }) => {
    const spend: GrantSpend = { ...EMPTY_GRANT_SPEND };
    for (const bucket of GRANT_SPEND_ORDER) {
      if (bucket !== 'bonus' || bonusAllowed) {
        spend[bucket] = take(available[bucket]);
      }
    }
    return spend;
  });
  const free = args.order === 'first' ? fromFree : take(args.free);
  return isPositive(remaining) ? null : { free, grants };
}
