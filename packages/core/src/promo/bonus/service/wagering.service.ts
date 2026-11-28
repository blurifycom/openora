import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
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
  isWagerRtp,
  type Uuid,
  type WagerTrackingCommands,
} from '@openora/core/contracts';
import {
  moneyAdd,
  moneyCompare,
  moneyMultiplyDivide,
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
import { isRealMoneyOnlyProduct, type StakeWagerInputs } from '../contract/index.js';
import { attributeStake } from '../shared/stake-attribution.js';
import { completeGrant } from '../shared/complete-grant.js';
import { isLiveGrantIn } from '../shared/live-grant.js';
import { effectiveContribution, weightedStake } from '../shared/wagering-weight.js';
import {
  DEFAULT_FUND_SETTINGS,
  allowedBuckets,
  betClass,
  clampCounters,
  isDepleted,
  splitAcross,
  type FundBucket,
  type FundSplit,
} from '../shared/fund-buckets.js';

const ZERO = '0';

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
  credited: string;
  bonusReturned: string;
  realReturned: string;
  unlinkedReturned: string;
  linkedReturned: string;
};

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

    const maxBet = realOnly ? null : strictestMaxBet(locked, args.context.product);
    if (maxBet !== null && isPositive(args.stake)) {
      const roundStake = moneyAdd(await this.outstandingRoundStake(tx, args), args.stake);
      if (moneyCompare(roundStake, maxBet) > 0) {
        return { ok: false, reason: 'max_bet_exceeded', maxBet, roundStake };
      }
    }

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
        allowed: plan.allowed,
      })),
      order: primary.settings.freeFundsOrder,
    });
    if (spent === null) {
      if (grants.some((plan) => plan.classRestricted)) {
        const permitted = grants.reduce(
          (sum, plan, i) =>
            moneyAdd(
              sum,
              sumAllowed(
                {
                  free: ZERO,
                  unlinked: counters[i]?.unlinked ?? ZERO,
                  linked: counters[i]?.linked ?? ZERO,
                  bonus: plan.grant.bonusBalance,
                },
                plan.allowed,
              ),
            ),
          realLeft,
        );
        return { ok: false, reason: 'restricted_funds', permitted };
      }
      const bonusAvailable = grants
        .filter((plan) => plan.allowed.has('bonus'))
        .reduce((sum, plan) => moneyAdd(sum, plan.grant.bonusBalance), ZERO);
      return { ok: false, reason: 'insufficient_bonus', bonusAvailable };
    }

    const pending = await this.pendingProgress(
      tx,
      grants.map((plan) => plan.grant.id),
    );
    const attribution = attributeStake(
      grants.map((plan, i) => {
        const own = spent.grants[i] ?? EMPTY_GRANT_SPEND;
        const room = moneySubtract(
          moneySubtract(plan.grant.wageringRequired, plan.grant.wageringProgress),
          pending.get(plan.grant.id) ?? ZERO,
        );
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
        throw new Error(`bonus grant ${plan.grant.id} refused a stake it was locked to cover`);
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
        wageringDelta: ZERO,
        wagerInputs: plan.wagerInputs,
        balanceAfter: after.balanceAfter,
        ...round,
      });
      await this.openRound(tx, args, { grantId: plan.grant.id, weighted: share.progress });
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
    const lockedGrantIds = await this.lockRoundGrants(tx, args);
    const stakes = await this.roundStakes(
      tx,
      args.userId,
      args.currency,
      args.providerName,
      args.externalRoundId,
    );
    const reversal = args.kind === 'bet_reversal';

    if (stakes.length === 0) {
      if (reversal) {
        await this.reverseTracking(tx, args, args.amount);
      }
      return { bonusShare: ZERO, realShare: args.amount, completed: [] };
    }

    const outstanding = stakes.map((stake) => outstandingOf(stake));
    const totalStake = outstanding.reduce(
      (sum, row) => moneyAdd(sum, moneyAdd(row.bonus, row.realTotal)),
      ZERO,
    );

    if (!isPositive(totalStake)) {
      await this.settleRound(tx, args, lockedGrantIds);
      return { bonusShare: ZERO, realShare: ZERO, completed: [] };
    }

    const applyAmount =
      reversal && moneyCompare(args.amount, totalStake) > 0 ? totalStake : args.amount;
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
      await this.reverseTracking(tx, args, realReturned);
    }

    let settled = ZERO;
    let forfeited = ZERO;
    for (const { row, slice } of slices) {
      const realSlice = moneyAdd(slice.free, moneyAdd(slice.unlinked, slice.linked));
      if (!isPositive(slice.bonus) && !isPositive(realSlice)) {
        continue;
      }

      const applied = reversal
        ? await this.reverseRound(tx, args, { outstanding: row, slice })
        : await this.creditBonus(tx, row.stake.grantId, slice);
      if (applied === null) {
        const status = await this.grantStatus(tx, row.stake.grantId);
        if (status !== 'completed' && isPositive(slice.bonus)) {
          forfeited = moneyAdd(forfeited, slice.bonus);
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

    const realShareOut = moneySubtract(moneySubtract(applyAmount, settled), forfeited);
    const realShare = isPositive(realShareOut) ? realShareOut : ZERO;

    if (!args.final && !(reversal && moneyCompare(applyAmount, totalStake) >= 0)) {
      return { bonusShare: settled, realShare, completed: [] };
    }
    const grantIds = await this.settleRound(tx, args, lockedGrantIds);
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
      .where(isLiveGrantIn(userId, currency))
      .orderBy(asc(promoGrant.id))
      .for('update');
    return rows.sort(
      (a, b) =>
        a.expiresAt.getTime() - b.expiresAt.getTime() ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

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

  private async openRound(
    tx: DrizzleTx,
    args: BonusWagerArgs,
    { grantId, weighted }: { grantId: PromoGrant['id']; weighted: string },
  ) {
    await tx
      .insert(promoGrantRound)
      .values({
        grantId,
        userId: args.userId,
        currency: args.currency,
        providerName: args.providerName,
        externalRoundId: args.externalRoundId,
        progressPending: weighted,
      })
      .onConflictDoUpdate({
        target: [
          promoGrantRound.grantId,
          promoGrantRound.providerName,
          promoGrantRound.externalRoundId,
        ],
        set: {
          settledAt: null,
          progressPending: sql`${promoGrantRound.progressPending} + ${weighted}::numeric`,
        },
      });
  }

  private async pendingProgress(
    tx: DrizzleTx,
    grantIds: PromoGrant['id'][],
  ): Promise<Map<PromoGrant['id'], string>> {
    if (grantIds.length === 0) {
      return new Map();
    }
    const rows = await tx
      .select({
        grantId: promoGrantRound.grantId,
        pending: sql<string>`sum(${promoGrantRound.progressPending})`,
      })
      .from(promoGrantRound)
      .where(
        and(
          inArray(promoGrantRound.grantId, grantIds),
          isNull(promoGrantRound.settledAt),
          gt(promoGrantRound.progressPending, ZERO),
        ),
      )
      .groupBy(promoGrantRound.grantId);
    return new Map(rows.map((row) => [row.grantId, row.pending]));
  }

  private async lockRoundGrants(tx: DrizzleTx, args: RoundKey): Promise<PromoGrant['id'][]> {
    const rows = await tx
      .selectDistinct({ grantId: promoGrantRound.grantId })
      .from(promoGrantRound)
      .where(roundWhere(args));
    const ids = rows.map((row) => row.grantId).sort();
    if (ids.length > 0) {
      await tx
        .select({ id: promoGrant.id })
        .from(promoGrant)
        .where(inArray(promoGrant.id, ids))
        .orderBy(asc(promoGrant.id))
        .for('update');
    }
    return ids;
  }

  private async settleRound(
    tx: DrizzleTx,
    args: RoundKey,
    lockedGrantIds?: PromoGrant['id'][],
  ): Promise<PromoGrant['id'][]> {
    const grantIds = lockedGrantIds ?? (await this.lockRoundGrants(tx, args));
    if (grantIds.length === 0) {
      return [];
    }
    const rounds = await tx
      .select({
        id: promoGrantRound.id,
        grantId: promoGrantRound.grantId,
        progressPending: promoGrantRound.progressPending,
      })
      .from(promoGrantRound)
      .where(
        and(
          roundWhere(args),
          inArray(promoGrantRound.grantId, grantIds),
          or(isNull(promoGrantRound.settledAt), gt(promoGrantRound.progressPending, ZERO)),
        ),
      )
      .orderBy(asc(promoGrantRound.grantId))
      .for('update');
    if (rounds.length === 0) {
      return [];
    }
    await tx
      .update(promoGrantRound)
      .set({ settledAt: sql`coalesce(${promoGrantRound.settledAt}, now())`, progressPending: ZERO })
      .where(
        inArray(
          promoGrantRound.id,
          rounds.map((round) => round.id),
        ),
      );
    for (const round of rounds) {
      if (isPositive(round.progressPending)) {
        await this.creditProgress(tx, args, {
          grantId: round.grantId,
          pending: round.progressPending,
        });
      }
    }
    return [...new Set(rounds.map((round) => round.grantId))].sort();
  }

  private async creditProgress(
    tx: DrizzleTx,
    args: RoundKey,
    { grantId, pending }: { grantId: PromoGrant['id']; pending: string },
  ) {
    const [grant] = await tx
      .select({
        wageringRequired: promoGrant.wageringRequired,
        wageringProgress: promoGrant.wageringProgress,
        bonusBalance: promoGrant.bonusBalance,
      })
      .from(promoGrant)
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')));
    if (!grant) {
      return;
    }
    const headroom = moneySubtract(grant.wageringRequired, grant.wageringProgress);
    const credited = moneyCompare(pending, headroom) < 0 ? pending : headroom;
    if (!isPositive(credited)) {
      return;
    }
    await tx
      .update(promoGrant)
      .set({ wageringProgress: sql`${promoGrant.wageringProgress} + ${credited}::numeric` })
      .where(eq(promoGrant.id, grantId));
    await tx.insert(promoGrantEntry).values({
      grantId,
      userId: args.userId,
      currency: args.currency,
      type: 'progress',
      bonusAmount: ZERO,
      wageringDelta: credited,
      balanceAfter: grant.bonusBalance,
      providerName: args.providerName,
      externalRoundId: args.externalRoundId,
    });
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
      return completeGrant(tx, grant);
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
    const onStake = sql`${promoGrantEntry.type} = 'stake'`;
    const onReversal = sql`${promoGrantEntry.type} = 'reversal'`;
    const always = sql`true`;
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
        credited: total(always, promoGrantEntry.wageringDelta),
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
          inArray(promoGrantEntry.type, ['stake', 'reversal', 'progress']),
        ),
      )
      .groupBy(promoGrantEntry.grantId)
      .orderBy(asc(promoGrantEntry.grantId));
  }

  private async grantStatus(tx: DrizzleTx, grantId: PromoGrant['id']) {
    const [row] = await tx
      .select({ status: promoGrant.status })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    return row?.status ?? null;
  }

  private async grantBalance(tx: DrizzleTx, grantId: PromoGrant['id']) {
    const [row] = await tx
      .select({ bonusBalance: promoGrant.bonusBalance })
      .from(promoGrant)
      .where(eq(promoGrant.id, grantId));
    return row?.bonusBalance ?? ZERO;
  }

  private async creditBonus(tx: DrizzleTx, grantId: PromoGrant['id'], slice: FundSplit) {
    const [row] = await tx
      .update(promoGrant)
      .set(returnTo(slice))
      .where(and(eq(promoGrant.id, grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    return row ? { balanceAfter: row.balanceAfter, progressReversed: ZERO } : null;
  }

  private async reverseRound(
    tx: DrizzleTx,
    args: RoundKey,
    { outstanding, slice }: { outstanding: Outstanding; slice: FundSplit },
  ) {
    const { stake } = outstanding;
    const total = moneyAdd(outstanding.bonus, outstanding.realTotal);
    const returned = moneyAdd(
      moneyAdd(slice.bonus, slice.free),
      moneyAdd(slice.unlinked, slice.linked),
    );
    const shareOf = (amount: string) =>
      isPositive(total) && isPositive(amount) ? moneyMultiplyDivide(amount, returned, total) : ZERO;
    const progressReversed = shareOf(stake.credited);
    const [row] = await tx
      .update(promoGrant)
      .set({
        ...returnTo(slice),
        wageringProgress: sql`GREATEST(0, ${promoGrant.wageringProgress} - ${progressReversed}::numeric)`,
      })
      .where(and(eq(promoGrant.id, stake.grantId), eq(promoGrant.status, 'active')))
      .returning({ balanceAfter: promoGrant.bonusBalance });
    if (!row) {
      return null;
    }
    const [round] = await tx
      .select({ id: promoGrantRound.id, progressPending: promoGrantRound.progressPending })
      .from(promoGrantRound)
      .where(and(roundWhere(args), eq(promoGrantRound.grantId, stake.grantId)))
      .for('update');
    const pendingReversed = round ? shareOf(round.progressPending) : ZERO;
    if (round && isPositive(pendingReversed)) {
      await tx
        .update(promoGrantRound)
        .set({
          progressPending: sql`GREATEST(0, ${promoGrantRound.progressPending} - ${pendingReversed}::numeric)`,
        })
        .where(eq(promoGrantRound.id, round.id));
    }
    return { balanceAfter: row.balanceAfter, progressReversed };
  }
}

function roundLockKey(args: RoundKey) {
  return `promo-round-settle:${args.userId}:${args.providerName}:${args.currency}:${args.externalRoundId}`;
}

function roundWhere(args: RoundKey) {
  return and(
    eq(promoGrantRound.userId, args.userId),
    eq(promoGrantRound.currency, args.currency),
    eq(promoGrantRound.providerName, args.providerName),
    eq(promoGrantRound.externalRoundId, args.externalRoundId),
  );
}

function sumAllowed(available: FundSplit, allowed: ReadonlySet<FundBucket>): string {
  return [...allowed].reduce((sum, bucket) => moneyAdd(sum, available[bucket]), ZERO);
}

type Outstanding = ReturnType<typeof outstandingOf>;

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

const GRANT_SPEND_ORDER = ['unlinked', 'linked', 'bonus'] as const;

function planGrant(grant: LiveGrant, args: BonusWagerArgs, realOnly: boolean) {
  const excluded = grant.terms.excludedProducts?.includes(args.context.product) === true;
  const settings = grant.terms.funds ?? DEFAULT_FUND_SETTINGS;
  const mode = grant.terms.contributionMode ?? 'flat';
  const contribution = effectiveContribution({
    rows: grant.terms.weights,
    context: args.context,
    mode,
    referenceEdge: grant.terms.referenceEdge,
  });
  const percent = realOnly ? ZERO : contribution.effectivePercent;
  const cls = betClass(args.context, percent);
  const fundRules = realOnly ? DEFAULT_FUND_SETTINGS : settings;
  const allowed = allowedBuckets(fundRules, cls, realOnly || excluded);
  const unrestricted = allowedBuckets(DEFAULT_FUND_SETTINGS, cls, realOnly || excluded);
  const { rtp } = args.context;
  const wagerInputs: StakeWagerInputs = {
    mode,
    rtp: rtp !== undefined && isWagerRtp(rtp) ? rtp : null,
    categoryPercent: contribution.categoryPercent,
    referenceEdge: contribution.referenceEdge,
    effectivePercent: percent,
    profileVersion: grant.terms.weightProfileVersion ?? null,
    betClass: cls,
  };
  return {
    grant,
    settings,
    allowed,
    classRestricted: allowed.size < unrestricted.size,
    percent,
    wagerInputs,
  };
}

function sumOf(a: string, b: string): string {
  if (moneyCompare(a, ZERO) === 0) {
    return b;
  }
  if (moneyCompare(b, ZERO) === 0) {
    return a;
  }
  return moneyAdd(a, b);
}

export function strictestMaxBet(
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

export function splitAcrossGrants(args: {
  stake: string;
  free: string;
  grants: readonly { available: GrantSpend; allowed: ReadonlySet<FundBucket> }[];
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
  const grants = args.grants.map(({ available, allowed }) => {
    const spend: GrantSpend = { ...EMPTY_GRANT_SPEND };
    for (const bucket of GRANT_SPEND_ORDER) {
      if (allowed.has(bucket)) {
        spend[bucket] = take(available[bucket]);
      }
    }
    return spend;
  });
  const free = args.order === 'first' ? fromFree : take(args.free);
  return isPositive(remaining) ? null : { free, grants };
}
