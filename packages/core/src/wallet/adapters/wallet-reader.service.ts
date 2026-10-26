import { type DrizzleDb, DrizzleService, moneyCompare, sumInPivot } from '@openora/core/server';
import {
  type WalletReader,
  type WalletBalancesReading,
  type WalletLastDeposit,
  type WalletLifetimeWithdrawals,
  type WalletProviderTransaction,
  type WalletTransactionStatus,
  type WalletWithdrawalRequests,
  type ExchangeRateReader,
} from '@openora/core/contracts';
import { and, count, desc, eq, gt, gte, inArray, lt, notInArray, sql, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';
import {
  IN_FLIGHT_TRANSACTION_STATUSES,
  VELOCITY_IGNORED_STATUSES,
  providerRefCondition,
  readWalletBalances,
  resolveWalletBalance,
} from '../service/wallet.service.js';

// A held deposit reaches the balance when an operator releases it, which stamps reviewedAt;
// every other completed deposit has no reviewedAt.
const depositedAt = () =>
  sql<Date>`coalesce(${walletTransaction.reviewedAt}, ${walletTransaction.createdAt})`;

type CurrencyTotal = { currency: string; total: string | null };

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

  getBalances(userId: string, tx?: unknown): Promise<WalletBalancesReading> {
    return readWalletBalances(this.on(tx), userId, this.defaultCurrency);
  }

  // A caller already inside a transaction passes it: taking a second pool connection while
  // holding the first is how the pool deadlocks under a burst.
  private on(tx?: unknown): DrizzleDb {
    return tx === undefined ? this.drizzle.db : (tx as DrizzleDb);
  }

  /** Sum of a player's completed deposits, priced into pivotCurrency. Null when at least one
   * currency's amount could not be priced - never a partial or fabricated total. */
  async getLifetimeDeposit(userId: string, tx?: unknown): Promise<string | null> {
    const rows = await this.on(tx)
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
      tx,
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

  async isFirstDeposit(userId: string, transactionId: string, tx?: unknown): Promise<boolean> {
    const [txn] = await this.on(tx)
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
    const [earlier] = await this.on(tx)
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

  async getLifetimeWithdrawals(userId: string): Promise<WalletLifetimeWithdrawals> {
    const rows = await this.drizzle.db
      .select({
        status: walletTransaction.status,
        currency: walletTransaction.currency,
        total: sum(walletTransaction.amount),
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'withdrawal'),
          inArray(walletTransaction.status, ['completed', ...IN_FLIGHT_TRANSACTION_STATUSES]),
        ),
      )
      .groupBy(walletTransaction.status, walletTransaction.currency);
    const pricedIn = (statuses: readonly WalletTransactionStatus[]) =>
      this.priced(rows.filter((row) => statuses.includes(row.status)));
    return {
      completed: await pricedIn(['completed']),
      open: await pricedIn(IN_FLIGHT_TRANSACTION_STATUSES),
      pivotCurrency: this.pivotCurrency,
    };
  }

  async getLastDeposit(userId: string): Promise<WalletLastDeposit | null> {
    const [last] = await this.drizzle.db
      .select({
        transactionId: walletTransaction.id,
        at: depositedAt().mapWith(walletTransaction.createdAt),
        amount: walletTransaction.amount,
        currency: walletTransaction.currency,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
        ),
      )
      .orderBy(desc(depositedAt()), desc(walletTransaction.id))
      .limit(1);
    if (!last) {
      return null;
    }
    const pivotAmount = await this.priced([{ currency: last.currency, total: last.amount }]);
    return { ...last, pivotAmount, pivotCurrency: this.pivotCurrency };
  }

  async getLastDepositAts(userIds: readonly string[]): Promise<Map<string, Date>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.drizzle.db
      .select({
        userId: wallet.userId,
        at: sql<Date>`max(${depositedAt()})`.mapWith(walletTransaction.createdAt),
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          inArray(wallet.userId, [...userIds]),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
        ),
      )
      .groupBy(wallet.userId);
    return new Map(rows.map((row) => [row.userId, row.at]));
  }

  async getTurnoverSince(userId: string, since: Date): Promise<string | null> {
    const rows = await this.drizzle.db
      .select({
        currency: walletTransaction.currency,
        total: sql<string>`greatest(sum(case when ${walletTransaction.type} = 'bet' then ${walletTransaction.amount} else -${walletTransaction.amount} end), 0)`,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          inArray(walletTransaction.type, ['bet', 'bet_reversal']),
          eq(walletTransaction.status, 'completed'),
          gte(walletTransaction.createdAt, since),
        ),
      )
      .groupBy(walletTransaction.currency);
    return this.priced(rows);
  }

  async getWithdrawalRequestsSince(userId: string, since: Date): Promise<WalletWithdrawalRequests> {
    const rows = await this.drizzle.db
      .select({
        currency: walletTransaction.currency,
        requests: count(),
        total: sum(walletTransaction.amount),
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'withdrawal'),
          gte(walletTransaction.createdAt, since),
          notInArray(walletTransaction.status, [...VELOCITY_IGNORED_STATUSES]),
        ),
      )
      .groupBy(walletTransaction.currency);
    return {
      count: rows.reduce((total, row) => total + row.requests, 0),
      pivotAmount: await this.priced(rows),
      pivotCurrency: this.pivotCurrency,
    };
  }

  // A currency whose amounts cancel out needs no rate, so it cannot make the total unknown.
  private priced(rows: readonly CurrencyTotal[]): Promise<string | null> {
    return sumInPivot(
      rows
        .map((row) => ({ currency: row.currency, total: row.total ?? '0' }))
        .filter((row) => moneyCompare(row.total, '0') !== 0),
      this.pivotCurrency,
      this.exchangeRateReader,
    );
  }
}
