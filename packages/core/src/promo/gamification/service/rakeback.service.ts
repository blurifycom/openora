import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import {
  isUsableRtp,
  type RakebackBasis,
  type RakebackPayout,
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
  moneyDivide,
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

// Paid when the bet settles, through recordSettledWager, so a rejected or cancelled bet earns nothing.
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

/** The part of a bet's own-money stake rakeback is a share of; zero when it cannot be priced. */
export function rakebackBase(realAmount: string, basis: RakebackBasis, rtp?: string): string {
  return basis === 'stake' ? realAmount : houseEdge(realAmount, rtp);
}

/** `base × rate% × (1 + uplift%)`: the streak uplift multiplies the rank rate, it never adds to it. */
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

/** A player with no rank earns `ratePercent` of the bet's theoretical GGR, its house edge; zero without a usable rtp. */
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

/**
 * Rakeback on a qualifying bet's own-money stake, or under the `margin` basis that stake times the
 * house edge of the game played (`1 − rtp`). A ranked player earns their rank's percentage; a
 * player's active streak milestone then multiplies it by `1 + uplift%`. A player holding no rank
 * earns nothing from the ladder, but an active streak milestone pays them its unranked rate on the
 * bet's theoretical GGR, the house edge, whatever the basis - so that formula always needs a usable
 * rtp. The streak only counts on its own products, and only while the player's last qualifying day
 * is today or yesterday; the rate is read from the current config when the bet settles.
 *
 * Under the `instant` payout it is credited to the real balance with the bet, and the `cashback`
 * wallet transaction is the whole record. Under `claim` it is written to `promo_rakeback_accrual`
 * and nothing moves until `RakebackClaimService` pays it out; a rollback of the round then takes
 * it back while it is still unclaimed.
 *
 * Runs after `RankService` and before `StreakService` in the composite, so a bet that also crosses
 * a rank threshold pays rakeback at the tier just reached, and the bet that unlocks a streak
 * milestone earns the previous milestone's rate.
 *
 * Own-money only: `args.realAmount` already excludes whatever part of the stake a bonus grant
 * paid for, so wagering a bonus never earns real-money rakeback on funds the player never risked.
 *
 * Takes a `getWallet` thunk rather than a resolved `WalletCommands`: `WALLET_COMMANDS`'s own
 * factory resolves `WAGER_TRACKING` transitively (through the bonus module's wagering service),
 * so resolving `WALLET_COMMANDS` eagerly while `WAGER_TRACKING` itself is still being built is a
 * circular `Container.get`. Deferring the lookup to the first bet - long after both tokens have
 * finished resolving - breaks the cycle.
 */
export class RakebackService implements WagerTrackingCommands {
  constructor(
    private readonly getWallet: () => WalletCommands | undefined,
    private readonly logger: { warn: (context: object, message: string) => void },
    private readonly settings: RakebackSettings = DEFAULT_SETTINGS,
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

  /** Takes back a reopened bet's unclaimed rakeback; a paid credit is left to a manual adjustment. */
  async reopenSettledWager(tx: DrizzleTx, args: WagerReversalArgs): Promise<void> {
    await this.reverseWager(tx, args);
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
    if (this.settings.payout === 'claim') {
      const streak = streakRecord(rate);
      await tx.insert(promoRakebackAccrual).values({
        userId: args.userId,
        currency: args.currency,
        amount: rakeback,
        stake: args.realAmount,
        basis: rate.mode === 'unranked' ? 'margin' : this.settings.basis,
        rtp: rate.mode === 'unranked' || this.settings.basis === 'margin' ? (rtp ?? null) : null,
        ratePercent: rate.mode === 'unranked' ? ZERO : rate.ratePercent,
        boostPercent: ZERO,
        ...streak,
        gameId: args.context.gameId ?? null,
        providerGameKey: args.context.providerGameKey ?? null,
        providerName: args.round?.providerName ?? args.context.provider,
        externalRoundId: args.round?.externalRoundId ?? null,
      });
      return [];
    }
    if (!wallet) {
      return [];
    }
    // Own-money only, priced in the bet's own currency - the currency the player is already
    // holding a balance in, so unlike a race/streak/rank-challenge prize (priced in whatever
    // currency their own config carries) this never opens a balance in one the player does not
    // already use.
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
    // `moved: false` is a replayed credit (a duplicate bet-tracking call, or a re-settle of a bet
    // already paid) - the balance already changed and was already announced the first time.
    return outcome.moved
      ? [{ transactionId: outcome.transactionId, amount: rakeback, currency: args.currency }]
      : [];
  }

  /**
   * Takes a rolled-back stake out of the round's accruals, newest first. A claimed or voided row
   * absorbs its share into `rolledBackStake` with its stake and amount untouched - paid rakeback is
   * only ever corrected by a manual adjustment - so a rollback after the claim never reaches an
   * older unclaimed row of the same round, and no share is absorbed twice.
   */
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
      .select({ rakebackPercent: promoRankTier.rakebackPercent })
      .from(promoRankTier)
      .where(eq(promoRankTier.id, rank.tierId));
    if (!tier) {
      return null;
    }
    return {
      mode: 'ranked',
      ratePercent: tier.rakebackPercent,
      upliftPercent: streak?.rankedUpliftPercent ?? ZERO,
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

function streakRecord(
  rate: RakebackRate,
):
  | { streakMode: StreakRakebackMode; streakPercent: string }
  | { streakMode: null; streakPercent: null } {
  const percent = rate.mode === 'unranked' ? rate.ratePercent : rate.upliftPercent;
  return moneyCompare(percent, ZERO) > 0
    ? { streakMode: rate.mode, streakPercent: percent }
    : { streakMode: null, streakPercent: null };
}
