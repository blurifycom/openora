import { DrizzleService } from '@openora/core/server';
import { type WalletReader } from '@openora/core/contracts';
import { and, count, eq, gt, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';

export class WalletReaderService implements WalletReader {
  constructor(private readonly drizzle: DrizzleService) {}

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
}
