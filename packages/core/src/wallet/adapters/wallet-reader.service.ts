import { DrizzleService } from '@openora/core/server';
import { type WalletReader, type WalletProviderTransaction } from '@openora/core/contracts';
import { and, count, eq, gt, inArray, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from '../schema/index.js';

// The caller only ever hands this a row matched by a WHERE on providerName/providerRefId
// both equal to non-null args, so a null here means the query itself is broken - guard
// rather than assert-away the column's nullability.
function toProviderTransaction(
  row: typeof walletTransaction.$inferSelect,
): WalletProviderTransaction {
  if (row.providerName === null || row.providerRefId === null) {
    throw new Error('toProviderTransaction: matched row is missing its provider ref columns');
  }
  return {
    id: row.id,
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
      .select()
      .from(walletTransaction)
      .where(
        and(
          eq(walletTransaction.providerName, providerName),
          eq(walletTransaction.providerRefId, providerRefId),
        ),
      );
    return row ? toProviderTransaction(row) : null;
  }
}
