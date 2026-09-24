import { DrizzleService, sumInPivot } from '@openora/core/server';
import {
  type WalletReader,
  type WalletBalancesReading,
  type WalletProviderTransaction,
  type ExchangeRateReader,
} from '@openora/core/contracts';
import { and, count, eq, gt, inArray, lt, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import {
  providerRefCondition,
  readWalletBalances,
  resolveWalletBalance,
} from '../service/wallet.service.js';

function toProviderTransaction(
  row: typeof walletTransaction.$inferSelect,
  userId: string,
): WalletProviderTransaction {
  if (row.providerName === null || row.providerRefId === null) {
    throw new Error('toProviderTransaction: matched row is missing its provider ref columns');
  }
  return {
    id: row.id,
    walletId: row.walletId,
    userId,
    type: row.type,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    providerName: row.providerName,
    providerRefId: row.providerRefId,
    externalRoundId: row.externalRoundId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export type WalletReaderServiceDeps = {
  drizzle: DrizzleService;
  defaultCurrency?: string;
  // Prices getLifetimeDeposit's per-currency sum into pivotCurrency (the platform's
  // configured exchange-rate pivot, e.g. resolveExchangeRatePivot(platformConfig.exchangeRate))
  // - a platform with no base currency can hold a player's deposits in several coins at once,
  // so a raw SUM across them (1 BTC + 20000 DOGE = 20001) is never a valid comparison.
  // exchangeRateReader stays optional so an fx-less install still resolves (getLifetimeDeposit
  // then answers null for any player holding a non-pivot-currency deposit).
  exchangeRateReader?: ExchangeRateReader;
  pivotCurrency: string;
};

export class WalletReaderService implements WalletReader {
  private readonly drizzle: DrizzleService;
  private readonly defaultCurrency: string | undefined;
  private readonly exchangeRateReader: ExchangeRateReader | undefined;
  private readonly pivotCurrency: string;

  constructor(deps: WalletReaderServiceDeps) {
    this.drizzle = deps.drizzle;
    this.defaultCurrency = deps.defaultCurrency;
    this.exchangeRateReader = deps.exchangeRateReader;
    this.pivotCurrency = deps.pivotCurrency;
  }

  getBalances(userId: string): Promise<WalletBalancesReading> {
    return readWalletBalances(this.drizzle.db, userId, this.defaultCurrency);
  }

  /** Sum of a player's completed deposits, priced into pivotCurrency. Null when at least one
   * currency's amount could not be priced - never a partial or fabricated total. */
  async getLifetimeDeposit(userId: string): Promise<string | null> {
    const rows = await this.drizzle.db
      .select({ currency: walletTransaction.currency, total: sum(walletTransaction.amount) })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
        ),
      )
      .groupBy(walletTransaction.currency);
    return sumInPivot(
      rows.map((row) => ({ currency: row.currency, total: row.total ?? '0' })),
      this.pivotCurrency,
      this.exchangeRateReader,
    );
  }

  async getWithdrawalCountInWindow(userId: string, windowDays: number): Promise<number> {
    // TODO: count completed withdrawals for userId within the last windowDays days
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const [row] = await this.drizzle.db
      .select({ n: count() })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'withdrawal'),
          eq(walletTransaction.status, 'completed'),
          gt(walletTransaction.createdAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async getWithdrawalCountsInWindow(
    userIds: string[],
    windowDays: number,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (userIds.length === 0) {
      return result;
    }
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const rows = await this.drizzle.db
      .select({ userId: wallet.userId, n: count() })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          inArray(wallet.userId, userIds),
          eq(walletTransaction.type, 'withdrawal'),
          eq(walletTransaction.status, 'completed'),
          gt(walletTransaction.createdAt, since),
        ),
      )
      .groupBy(wallet.userId);
    for (const row of rows) {
      result.set(row.userId, Number(row.n));
    }
    return result;
  }

  async findByProviderRef(
    providerName: string,
    providerRefId: string,
  ): Promise<WalletProviderTransaction | null> {
    const [row] = await this.drizzle.db
      .select({ transaction: walletTransaction, userId: wallet.userId })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(providerRefCondition(providerName, providerRefId));
    return row ? toProviderTransaction(row.transaction, row.userId) : null;
  }

  getBalance(userId: string): Promise<{ balance: string; currency: string }> {
    return resolveWalletBalance(this.drizzle.db, userId, this.defaultCurrency);
  }

  async isFirstDeposit(userId: string, transactionId: string): Promise<boolean> {
    const [txn] = await this.drizzle.db
      .select({ createdAt: walletTransaction.createdAt })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.id, transactionId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
        ),
      );
    if (!txn) {
      return false;
    }
    const [earlier] = await this.drizzle.db
      .select({ id: walletTransaction.id })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
          lt(walletTransaction.createdAt, txn.createdAt),
        ),
      )
      .limit(1);
    return !earlier;
  }
}
