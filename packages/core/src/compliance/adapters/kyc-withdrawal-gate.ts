import { and, eq, sql } from 'drizzle-orm';
import { moneyCompare, sumInPivot, type DrizzleService } from '@openora/core/server';
import type { ExchangeRateReader, KycWithdrawalPolicy } from '@openora/core/contracts';
// Cross-domain read via the public /schema subpath (ADR-0020): the ledger is the source of
// truth for lifetime deposits.
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  globalKycConfig,
  GLOBAL_KYC_CUMULATIVE_DEPOSIT_THRESHOLD_DEFAULT,
  GLOBAL_KYC_ENABLED_DEFAULT,
} from '../schema/index.js';

/**
 * The compliance-owned implementation of `KYC_WITHDRAWAL_POLICY`. Fail-closed: a withdrawal or
 * a deposit currency that cannot be priced into the pivot requires KYC.
 *
 * Country exemptions need no check here: an exempt player is approved at registration.
 */
export class KycWithdrawalGate implements KycWithdrawalPolicy {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader | undefined,
  ) {}

  async requiresKycForWithdrawal({
    userId,
    pivotAmount,
    pivotCurrency,
  }: {
    userId: string;
    pivotAmount: string | null;
    pivotCurrency: string;
  }): Promise<boolean> {
    const [config] = await this.drizzle.db
      .select()
      .from(globalKycConfig)
      .where(eq(globalKycConfig.singletonKey, 'global'));
    if (!(config?.enabled ?? GLOBAL_KYC_ENABLED_DEFAULT)) {
      return false;
    }
    if (pivotAmount === null) {
      return true;
    }
    const withdrawalThreshold = config?.withdrawalThreshold ?? null;
    if (withdrawalThreshold !== null && moneyCompare(pivotAmount, withdrawalThreshold) > 0) {
      return true;
    }
    const cumulativeDeposits = await this.completedDepositsInPivot(userId, pivotCurrency);
    return (
      cumulativeDeposits === null ||
      moneyCompare(
        cumulativeDeposits,
        config?.cumulativeDepositThreshold ?? GLOBAL_KYC_CUMULATIVE_DEPOSIT_THRESHOLD_DEFAULT,
      ) > 0
    );
  }

  private async completedDepositsInPivot(userId: string, pivotCurrency: string) {
    const depositsByCurrency = await this.drizzle.db
      .select({
        currency: walletTransaction.currency,
        total: sql<string>`coalesce(sum(${walletTransaction.amount}), 0)`,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
        ),
      )
      .groupBy(walletTransaction.currency);
    return sumInPivot(depositsByCurrency, pivotCurrency, this.rates);
  }
}
