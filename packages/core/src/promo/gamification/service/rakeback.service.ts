import { eq } from 'drizzle-orm';
import type {
  WagerTrackingArgs,
  WagerTrackingCommands,
  WalletCommands,
} from '@openora/core/contracts';
import {
  moneyAdd,
  moneyCompare,
  moneyDivide,
  moneyScaleBy,
  type DrizzleTx,
} from '@openora/core/server';
import { promoPlayerRank, promoRankConfig, promoRankTier } from '../schema/index.js';

const ZERO = '0';

// An empty list counts every bet, the same rule RankService applies to what counts toward the
// ladder - rakeback rides on the same eligibility, not a second setting an operator has to keep
// in sync with it.
const countsToward = (eligibleProducts: readonly string[], product: string) =>
  eligibleProducts.length === 0 || eligibleProducts.includes(product);

/**
 * Instant rakeback - Confluence "Rank Bonuses" Scenario 3: a qualifying bet's own-money stake
 * times the player's rank rakeback percentage (tier rate plus any active streak boost), credited
 * straight to the player's real balance in the same transaction as the bet. No house edge factor
 * and no claim step - the spec has rakeback land on the balance as it accrues, so the wallet
 * transaction it writes (type `cashback`) is the whole record; there is no separate ledger here.
 *
 * Runs after `RankService` in the composite, so a bet that also crosses a rank threshold pays
 * rakeback at the tier just reached.
 *
 * Own-money only: `args.realAmount` already excludes whatever part of the stake a bonus grant
 * paid for, so wagering a bonus never earns real-money rakeback on funds the player never risked.
 */
export class RakebackService implements WagerTrackingCommands {
  constructor(
    private readonly wallet: WalletCommands | undefined,
    private readonly logger: { warn: (context: object, message: string) => void },
  ) {}

  async recordWager(tx: DrizzleTx, args: WagerTrackingArgs) {
    if (!this.wallet || moneyCompare(args.realAmount, ZERO) <= 0) {
      return;
    }
    const [config] = await tx
      .select({ eligibleProducts: promoRankConfig.eligibleProducts })
      .from(promoRankConfig);
    if (!config || !countsToward(config.eligibleProducts, args.context.product)) {
      return;
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
      return;
    }
    const [tier] = await tx
      .select({ rakebackPercent: promoRankTier.rakebackPercent })
      .from(promoRankTier)
      .where(eq(promoRankTier.id, rank.tierId));
    if (!tier) {
      return;
    }
    const boostActive =
      rank.rakebackBoostExpiresAt !== null && rank.rakebackBoostExpiresAt > new Date();
    const rate = moneyAdd(
      tier.rakebackPercent,
      boostActive ? (rank.rakebackBoostPercent ?? ZERO) : ZERO,
    );
    const rakeback = moneyDivide(moneyScaleBy(args.realAmount, rate), '100');
    if (moneyCompare(rakeback, ZERO) <= 0) {
      return;
    }
    const outcome = await this.wallet.credit(tx, {
      userId: args.userId,
      amount: rakeback,
      currency: args.currency,
      type: 'cashback',
    });
    if (!outcome.ok) {
      this.logger.warn({ userId: args.userId, reason: outcome.reason }, 'rakeback credit failed');
    }
  }
}
