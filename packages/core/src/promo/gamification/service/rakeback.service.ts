import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type {
  RakebackBasis,
  RakebackPayout,
  WagerReversalArgs,
  WagerTrackingArgs,
  WagerTrackingCommands,
  WagerTrackingWalletCredit,
  WalletCommands,
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
  promoPlayerRank,
  promoRakebackAccrual,
  promoRankConfig,
  promoRankTier,
} from '../schema/index.js';
import { roundReversal } from '../shared/round-reversal.js';

const ZERO = '0';

// A percent value (`'96'`) fails it and pays nothing rather than being guessed at.
const RTP_PATTERN = /^(0(\.\d{1,18})?|1(\.0{1,18})?)$/;

export type RakebackSettings = { basis: RakebackBasis; payout: RakebackPayout };

const DEFAULT_SETTINGS: RakebackSettings = { basis: 'stake', payout: 'instant' };

// An empty list counts every bet, the same rule RankService applies to what counts toward the
// ladder - rakeback rides on the same eligibility, not a second setting an operator has to keep
// in sync with it.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

/** The part of a bet's own-money stake rakeback is a share of; zero when it cannot be priced. */
export function rakebackBase(realAmount: string, basis: RakebackBasis, rtp?: string): string {
  if (basis === 'stake') {
    return realAmount;
  }
  if (rtp === undefined || !RTP_PATTERN.test(rtp)) {
    return ZERO;
  }
  return moneyScaleBy(realAmount, moneySubtract('1', rtp));
}

/**
 * Rank rakeback: a qualifying bet's own-money stake, or under the `margin` basis that stake times
 * the house edge of the game played (`1 − rtp`), times the player's rank rakeback percentage
 * (tier rate plus any active streak boost).
 *
 * Under the `instant` payout it is credited to the real balance with the bet, and the `cashback`
 * wallet transaction is the whole record. Under `claim` it is written to `promo_rakeback_accrual`
 * and nothing moves until `RakebackClaimService` pays it out; a rollback of the round then takes
 * it back while it is still unclaimed.
 *
 * Runs after `RankService` in the composite, so a bet that also crosses a rank threshold pays
 * rakeback at the tier just reached.
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
    const base = rakebackBase(args.realAmount, this.settings.basis, args.context.rtp);
    const rakeback = moneyDivide(
      moneyScaleBy(base, moneyAdd(rate.ratePercent, rate.boostPercent)),
      '100',
    );
    if (moneyCompare(rakeback, ZERO) <= 0) {
      return [];
    }
    if (this.settings.payout === 'claim') {
      await tx.insert(promoRakebackAccrual).values({
        userId: args.userId,
        currency: args.currency,
        amount: rakeback,
        stake: args.realAmount,
        basis: this.settings.basis,
        rtp: this.settings.basis === 'margin' ? (args.context.rtp ?? null) : null,
        ratePercent: rate.ratePercent,
        boostPercent: rate.boostPercent,
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
    });
    if (!outcome.ok) {
      this.logger.warn({ userId: args.userId, reason: outcome.reason }, 'rakeback credit failed');
      return [];
    }
    // `moved: false` is a replayed credit (a duplicate bet-tracking call for the same bet) -
    // the balance already changed and was already announced the first time.
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
          eq(promoRakebackAccrual.userId, args.userId),
          eq(promoRakebackAccrual.providerName, args.round.providerName),
          eq(promoRakebackAccrual.currency, args.currency),
          eq(promoRakebackAccrual.externalRoundId, args.round.externalRoundId),
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
    args: WagerTrackingArgs,
  ): Promise<{ ratePercent: string; boostPercent: string } | null> {
    const [config] = await tx
      .select({ eligibleProducts: promoRankConfig.eligibleProducts })
      .from(promoRankConfig);
    if (!config || !countsToward(config.eligibleProducts, args.context.product)) {
      return null;
    }
    const [rank] = await tx
      .select({
        tierId: promoPlayerRank.tierId,
        rakebackBoostPercent: promoPlayerRank.rakebackBoostPercent,
        rakebackBoostExpiresAt: promoPlayerRank.rakebackBoostExpiresAt,
      })
      .from(promoPlayerRank)
      .where(eq(promoPlayerRank.userId, args.userId));
    if (!rank?.tierId) {
      return null;
    }
    const [tier] = await tx
      .select({ rakebackPercent: promoRankTier.rakebackPercent })
      .from(promoRankTier)
      .where(eq(promoRankTier.id, rank.tierId));
    if (!tier) {
      return null;
    }
    const boostActive =
      rank.rakebackBoostExpiresAt !== null && rank.rakebackBoostExpiresAt > new Date();
    return {
      ratePercent: tier.rakebackPercent,
      boostPercent: boostActive ? (rank.rakebackBoostPercent ?? ZERO) : ZERO,
    };
  }
}
