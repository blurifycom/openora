import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import {
  CONTRIBUTION_PERCENT_SCALE,
  type AuditWritePort,
  isUsableRtp,
  type RakebackBasis,
  type RakebackPayout,
  type RankPeriodicBasis,
  type SettledWagerArgs,
  type WagerReversalArgs,
  type WagerRound,
  type WagerTrackingArgs,
  type WagerTrackingCommands,
  type WagerTrackingWalletCredit,
  type WalletCommands,
  type WalletProviderRef,
} from '@openora/core/contracts';
import {
  moneyAdd,
  moneyCompare,
  moneyMin,
  moneyDivide,
  moneyFloorToScale,
  moneyMultiplyDivide,
  moneyScaleBy,
  moneySubtract,
  houseEdge,
  type DrizzleTx,
} from '@openora/core/server';
import type { StreakRakebackMode } from '../contract/index.js';
import {
  promoPlayerRank,
  promoPlayerStreak,
  promoRakebackAccrual,
  promoRankConfig,
  promoRankTier,
  promoStreakConfig,
} from '../schema/index.js';
import { roundReversal } from '../shared/round-reversal.js';
import { activeRakebackRate, isStreakLive, type StreakRate } from '../shared/streak-day.js';

const ZERO = '0';

const SETTLED_PRODUCT = 'sportsbook';
const SETTLED_PROVIDER_NAME = 'rakeback-settled';

const roundMatch = (userId: WagerReversalArgs['userId'], currency: string, round: WagerRound) => [
  eq(promoRakebackAccrual.userId, userId),
  eq(promoRakebackAccrual.providerName, round.providerName),
  eq(promoRakebackAccrual.currency, currency),
  eq(promoRakebackAccrual.externalRoundId, round.externalRoundId),
];

export type RakebackSettings = { basis: RakebackBasis; payout: RakebackPayout };

const DEFAULT_SETTINGS: RakebackSettings = { basis: 'stake', payout: 'instant' };

const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

export function rakebackBase(realAmount: string, basis: RakebackBasis, rtp?: string): string {
  return basis === 'stake' ? realAmount : houseEdge(realAmount, rtp);
}

export function upliftWithinEdge(
  tier: {
    rakebackPercent: string;
    dailyBonusPercent: string | null;
    weeklyBonusPercent: string | null;
    monthlyBonusPercent: string | null;
  },
  uplift: string,
  periodicBasis: RankPeriodicBasis,
): string {
  const bonuses =
    periodicBasis === 'margin'
      ? [tier.dailyBonusPercent, tier.weeklyBonusPercent, tier.monthlyBonusPercent]
      : [];
  const headroom = bonuses.reduce<string>(
    (left, percent) => moneySubtract(left, percent ?? ZERO),
    moneySubtract('100', tier.rakebackPercent),
  );
  if (moneyCompare(headroom, ZERO) <= 0 || moneyCompare(tier.rakebackPercent, ZERO) <= 0) {
    return ZERO;
  }
  const ceiling = moneyFloorToScale(
    moneyMultiplyDivide(headroom, '100', tier.rakebackPercent),
    CONTRIBUTION_PERCENT_SCALE,
  );
  return moneyMin(uplift, ceiling);
}

export function rankedRakeback({
  base,
  ratePercent,
  upliftPercent,
}: {
  base: string;
  ratePercent: string;
  upliftPercent: string;
}): string {
  return moneyDivide(
    moneyScaleBy(moneyScaleBy(base, ratePercent), moneyAdd('100', upliftPercent)),
    '10000',
  );
}

export function unrankedRakeback({
  realAmount,
  rtp,
  ratePercent,
}: {
  realAmount: string;
  rtp?: string | null;
  ratePercent: string;
}): string {
  return moneyDivide(moneyScaleBy(houseEdge(realAmount, rtp), ratePercent), '100');
}

type RakebackRate =
  | { mode: 'ranked'; ratePercent: string; upliftPercent: string }
  | { mode: 'unranked'; ratePercent: string };

export class RakebackService implements WagerTrackingCommands {
  constructor(
    private readonly getWallet: () => WalletCommands | undefined,
    private readonly logger: { warn: (context: object, message: string) => void },
    private readonly audit: Pick<AuditWritePort, 'recordManyInTransaction'>,
    private readonly settings: RakebackSettings = DEFAULT_SETTINGS,
    private readonly periodicBasis: RankPeriodicBasis = 'flat',
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs): Promise<WagerTrackingWalletCredit[]> {
    if (args.context.product === SETTLED_PRODUCT) {
      return [];
    }
    return this.pay(tx, args, undefined);
  }

  async recordSettledWager(
    tx: DrizzleTx,
    args: SettledWagerArgs,
  ): Promise<WagerTrackingWalletCredit[]> {
    const counted = await tx
      .select({ id: promoRakebackAccrual.id })
      .from(promoRakebackAccrual)
      .where(
        and(
          ...roundMatch(args.userId, args.currency, args.round),
          inArray(promoRakebackAccrual.status, ['accrued', 'claimed', 'voided']),
        ),
      )
      .limit(1)
      .for('update');
    if (counted.length > 0) {
      return [];
    }
    return this.pay(tx, args, {
      providerName: SETTLED_PROVIDER_NAME,
      providerRefId: `${args.round.providerName}:${args.round.externalRoundId}`,
    });
  }

  async reopenSettledWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    await this.reverseWager(tx, args);
  }

  async reverseSettledWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    const paid = await tx
      .select({
        id: promoRakebackAccrual.id,
        amount: promoRakebackAccrual.amount,
        claimId: promoRakebackAccrual.claimId,
      })
      .from(promoRakebackAccrual)
      .where(
        and(
          ...roundMatch(args.userId, args.currency, args.round),
          eq(promoRakebackAccrual.status, 'claimed'),
        ),
      );
    await this.audit.recordManyInTransaction(
      tx,
      paid.map((row) => ({
        actorType: 'system' as const,
        action: 'promo.rakeback.kept_on_void',
        resourceType: 'promo_rakeback_accrual',
        resourceId: row.id,
        after: {
          userId: args.userId,
          providerName: args.round.providerName,
          externalRoundId: args.round.externalRoundId,
          currency: args.currency,
          amount: row.amount,
          claimId: row.claimId,
        },
      })),
    );
  }

  private async pay(
    tx: DrizzleTx,
    args: Pick<WagerTrackingArgs, 'userId' | 'currency' | 'realAmount' | 'context' | 'round'>,
    providerRef: WalletProviderRef | undefined,
  ): Promise<WagerTrackingWalletCredit[]> {
    if (moneyCompare(args.realAmount, ZERO) <= 0) {
      return [];
    }
    const wallet = this.getWallet();
    if (this.settings.payout === 'instant' && !wallet) {
      return [];
    }
    const rate = await this.rateFor(tx, args);
    if (!rate) {
      return [];
    }
    const rtp = args.context.rtp;
    if ((rate.mode === 'unranked' || this.settings.basis === 'margin') && !isUsableRtp(rtp)) {
      this.logger.warn(
        {
          userId: args.userId,
          provider: args.context.provider,
          gameId: args.context.gameId ?? null,
          rtp: rtp ?? null,
        },
        rate.mode === 'unranked'
          ? 'streak rakeback skipped: bet has no usable rtp'
          : 'margin rakeback skipped: bet has no usable rtp',
      );
      return [];
    }
    const rakeback =
      rate.mode === 'unranked'
        ? unrankedRakeback({ realAmount: args.realAmount, rtp, ratePercent: rate.ratePercent })
        : rankedRakeback({
            base: rakebackBase(args.realAmount, this.settings.basis, rtp),
            ratePercent: rate.ratePercent,
            upliftPercent: rate.upliftPercent,
          });
    if (moneyCompare(rakeback, ZERO) <= 0) {
      return [];
    }
    const accrual = {
      userId: args.userId,
      currency: args.currency,
      amount: rakeback,
      stake: args.realAmount,
      basis: rate.mode === 'unranked' ? 'margin' : this.settings.basis,
      rtp: rate.mode === 'unranked' || this.settings.basis === 'margin' ? (rtp ?? null) : null,
      ratePercent: rate.mode === 'unranked' ? ZERO : rate.ratePercent,
      boostPercent: ZERO,
      ...streakRecord(rate),
      gameId: args.context.gameId ?? null,
      providerGameKey: args.context.providerGameKey ?? null,
      providerName: args.round?.providerName ?? args.context.provider,
      externalRoundId: args.round?.externalRoundId ?? null,
    } satisfies typeof promoRakebackAccrual.$inferInsert;
    if (this.settings.payout === 'claim') {
      await tx.insert(promoRakebackAccrual).values(accrual);
      return [];
    }
    if (!wallet) {
      return [];
    }
    const outcome = await wallet.credit(tx, {
      userId: args.userId,
      amount: rakeback,
      currency: args.currency,
      type: 'cashback',
      ...(providerRef ? { providerRef } : {}),
    });
    if (!outcome.ok) {
      this.logger.warn({ userId: args.userId, reason: outcome.reason }, 'rakeback credit failed');
      return [];
    }
    if (providerRef) {
      await tx
        .insert(promoRakebackAccrual)
        .values({ ...accrual, status: 'claimed', settledAt: new Date() });
    }
    return outcome.moved
      ? [{ transactionId: outcome.transactionId, amount: rakeback, currency: args.currency }]
      : [];
  }

  async reverseWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    if (moneyCompare(args.realAmount, ZERO) <= 0) {
      return;
    }
    const rows = await tx
      .select({
        id: promoRakebackAccrual.id,
        status: promoRakebackAccrual.status,
        stake: promoRakebackAccrual.stake,
        rolledBackStake: promoRakebackAccrual.rolledBackStake,
        amount: promoRakebackAccrual.amount,
      })
      .from(promoRakebackAccrual)
      .where(
        and(
          ...roundMatch(args.userId, args.currency, args.round),
          inArray(promoRakebackAccrual.status, ['accrued', 'claimed', 'voided']),
          gt(promoRakebackAccrual.stake, promoRakebackAccrual.rolledBackStake),
        ),
      )
      .orderBy(desc(promoRakebackAccrual.createdAt), desc(promoRakebackAccrual.id))
      .for('update');

    let remaining = args.realAmount;
    for (const row of rows) {
      if (moneyCompare(remaining, ZERO) <= 0) {
        return;
      }
      const standing = moneySubtract(row.stake, row.rolledBackStake);
      const reversed = roundReversal({ stake: standing, wagered: row.amount }, remaining);
      remaining = moneySubtract(remaining, reversed.stake);
      const amount = moneySubtract(row.amount, reversed.wagered);
      await tx
        .update(promoRakebackAccrual)
        .set(
          row.status !== 'accrued'
            ? { rolledBackStake: moneyAdd(row.rolledBackStake, reversed.stake) }
            : moneyCompare(amount, ZERO) <= 0
              ? { status: 'reversed', settledAt: new Date() }
              : { stake: moneySubtract(row.stake, reversed.stake), amount },
        )
        .where(eq(promoRakebackAccrual.id, row.id));
    }
  }

  private async rateFor(
    tx: DrizzleTx,
    args: Pick<WagerTrackingArgs, 'userId' | 'context'>,
  ): Promise<RakebackRate | null> {
    const [rank] = await tx
      .select({ tierId: promoPlayerRank.tierId })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, args.userId));
    const streak = await this.streakRateFor(tx, args);
    if (!rank?.tierId) {
      return streak ? { mode: 'unranked', ratePercent: streak.unrankedRatePercent } : null;
    }
    const [config] = await tx
      .select({
        eligibleProducts: promoRankConfig.eligibleProducts,
        rakebackEligibleProducts: promoRankConfig.rakebackEligibleProducts,
      })
      .from(promoRankConfig);
    if (
      !config ||
      !countsToward(config.eligibleProducts, args.context.product) ||
      !countsToward(config.rakebackEligibleProducts, args.context.product)
    ) {
      return null;
    }
    const [tier] = await tx
      .select({
        rakebackPercent: promoRankTier.rakebackPercent,
        dailyBonusPercent: promoRankTier.dailyBonusPercent,
        weeklyBonusPercent: promoRankTier.weeklyBonusPercent,
        monthlyBonusPercent: promoRankTier.monthlyBonusPercent,
      })
      .from(promoRankTier)
      .where(eq(promoRankTier.id, rank.tierId));
    if (!tier) {
      return null;
    }
    const uplift = streak?.rankedUpliftPercent ?? ZERO;
    return {
      mode: 'ranked',
      ratePercent: tier.rakebackPercent,
      upliftPercent:
        this.settings.basis === 'margin'
          ? upliftWithinEdge(tier, uplift, this.periodicBasis)
          : uplift,
    };
  }

  private async streakRateFor(
    tx: DrizzleTx,
    args: Pick<WagerTrackingArgs, 'userId' | 'context'>,
  ): Promise<StreakRate | null> {
    const [config] = await tx
      .select({
        enabled: promoStreakConfig.enabled,
        rakebackMilestones: promoStreakConfig.rakebackMilestones,
        eligibleProducts: promoStreakConfig.eligibleProducts,
      })
      .from(promoStreakConfig);
    if (
      !config?.enabled ||
      config.rakebackMilestones.length === 0 ||
      !countsToward(config.eligibleProducts, args.context.product)
    ) {
      return null;
    }
    const [streak] = await tx
      .select({
        current: promoPlayerStreak.current,
        lastQualifyingDay: promoPlayerStreak.lastQualifyingDay,
      })
      .from(promoPlayerStreak)
      .where(eq(promoPlayerStreak.userId, args.userId));
    if (!streak || !isStreakLive(streak.lastQualifyingDay, new Date())) {
      return null;
    }
    return activeRakebackRate(config.rakebackMilestones, streak.current);
  }
}

export function streakRecord(
  rate: RakebackRate,
):
  | { streakMode: StreakRakebackMode; streakPercent: string }
  | { streakMode: null; streakPercent: null } {
  const percent = rate.mode === 'unranked' ? rate.ratePercent : rate.upliftPercent;
  return moneyCompare(percent, ZERO) > 0
    ? { streakMode: rate.mode, streakPercent: percent }
    : { streakMode: null, streakPercent: null };
}
