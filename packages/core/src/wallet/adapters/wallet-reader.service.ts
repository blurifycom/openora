import { DrizzleService } from '@openora/core/server';
import { type WalletReader, type WalletBalancesReading } from '@openora/core/contracts';
import { and, count, eq, gt, inArray, sum } from 'drizzle-orm';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';

// Mirrors WalletService.getBalances's own default - no wallet row yet still needs
// an answer, never a throw.
const DEFAULT_WALLET_CURRENCY = 'USD';

export class WalletReaderService implements WalletReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async getBalances(userId: string): Promise<WalletBalancesReading> {
    const [record] = await this.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
    if (!record) {
      return { activeCurrency: DEFAULT_WALLET_CURRENCY, balances: [] };
    }

    const rows = await this.drizzle.db
      .select({ currency: walletBalance.currency, balance: walletBalance.amount })
      .from(walletBalance)
      .where(eq(walletBalance.walletId, record.id))
      .orderBy(walletBalance.currency);

    return { activeCurrency: record.currency, balances: rows };
  }

  async getLifetimeDeposit(userId: string): Promise<string> {
    const [row] = await this.drizzle.db
      .select({ total: sum(walletTransaction.amount) })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(
        and(
          eq(wallet.userId, userId),
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
        ),
      );
    return row?.total ?? '0';
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
}
