import type { AdminTxListOptions, AdminTxRow, AdminWalletReporting } from '@oss/core/contracts';
import { DrizzleService, pageToOffset } from '@oss/core/server';
import { and, count, desc, eq, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from './schema/index.js';

// Wallet owns money movement, so it owns the admin reporting port. The back-office
// (admin-console) depends only on ADMIN_WALLET_REPORTING - never on this schema.
// See ADR-0017/0025.
export class DrizzleAdminWalletReporting implements AdminWalletReporting {
  constructor(private readonly drizzle: DrizzleService) {}

  async totals(): Promise<{ deposits: number; withdrawals: number }> {
    const db = this.drizzle.db;
    const [deposits, withdrawals] = await Promise.all([
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(eq(walletTransaction.type, 'deposit'), eq(walletTransaction.status, 'completed')),
        )
        .then(([r]) => Number(r?.total ?? 0)),
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(eq(walletTransaction.type, 'withdrawal'), eq(walletTransaction.status, 'completed')),
        )
        .then(([r]) => Number(r?.total ?? 0)),
    ]);
    return { deposits, withdrawals };
  }

  async listTransactions({ page, limit, userId }: AdminTxListOptions) {
    const db = this.drizzle.db;
    const where = userId ? eq(wallet.userId, userId) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ tx: walletTransaction, walletUserId: wallet.userId })
        .from(walletTransaction)
        .leftJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(where)
        .orderBy(desc(walletTransaction.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(walletTransaction)
        .leftJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(where),
    ]);
    return {
      rows: rows.map(
        ({ tx, walletUserId }): AdminTxRow => ({
          id: tx.id,
          userId: walletUserId ?? tx.walletId,
          type: tx.type,
          amount: Number(tx.amount),
          currency: tx.currency,
          status: tx.status,
          createdAt: tx.createdAt,
        }),
      ),
      total: Number(n),
    };
  }
}
