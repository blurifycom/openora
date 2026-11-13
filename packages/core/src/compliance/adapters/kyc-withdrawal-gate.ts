import { eq } from 'drizzle-orm';
import { moneyCompare, sumInPivot, type DrizzleService } from '@openora/core/server';
import type {
  ExchangeRateReader,
  KycWithdrawalPolicy,
  WalletReader,
} from '@openora/core/contracts';
import {
  globalKycConfig,
  GLOBAL_KYC_CUMULATIVE_DEPOSIT_THRESHOLD_DEFAULT,
  GLOBAL_KYC_ENABLED_DEFAULT,
} from '../schema/index.js';

/**
 * The compliance-owned implementation of `KYC_WITHDRAWAL_POLICY`. Fail-closed: a withdrawal or
 * a deposit currency that cannot be priced into the pivot requires KYC, and a failed deposits
 * read rejects, which refuses the request and leaves an auto-approval to a human.
 *
 * Country exemptions need no check here: an exempt player is approved at registration.
 */
export class KycWithdrawalGate implements KycWithdrawalPolicy {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly rates: ExchangeRateReader | undefined,
    private readonly walletReader: WalletReader,
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
    return sumInPivot(
      await this.walletReader.getDepositsByCurrency(userId),
      pivotCurrency,
      this.rates,
    );
  }
}
