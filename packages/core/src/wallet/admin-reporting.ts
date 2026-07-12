import type { AdminTxListOptions, AdminWalletReporting } from '@openora/core/contracts';
import { DrizzleService, pageToOffset } from '@openora/core/server';
import { and, count, desc, eq, gte, inArray, lte, sum } from 'drizzle-orm';
import { wallet, walletTransaction } from './schema/index.js';

// See ADR-0017/0025.
export class DrizzleAdminWalletReporting implements AdminWalletReporting {
  constructor(private readonly drizzle: DrizzleService) {}

  async totals() {
    const db = this.drizzle.db;
    const [deposits, withdrawals] = await Promise.all([
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(eq(walletTransaction.type, 'deposit'), eq(walletTransaction.status, 'completed')),
        )
        .then(([r]) => r?.total ?? '0'),
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(eq(walletTransaction.type, 'withdrawal'), eq(walletTransaction.status, 'completed')),
        )
        .then(([r]) => r?.total ?? '0'),
    ]);
    return { deposits, withdrawals };
  }

  async listTransactions({
    page,
    limit,
    userIds,
    type,
    currency,
    rail,
    status,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
  }: AdminTxListOptions) {
    const db = this.drizzle.db;
    const conditions = [
      userIds && userIds.length > 0 ? inArray(wallet.userId, userIds) : undefined,
      type ? eq(walletTransaction.type, type) : undefined,
      currency ? eq(walletTransaction.currency, currency) : undefined,
      rail ? eq(walletTransaction.rail, rail) : undefined,
      status ? eq(walletTransaction.status, status) : undefined,
      dateFrom ? gte(walletTransaction.createdAt, dateFrom) : undefined,
      dateTo ? lte(walletTransaction.createdAt, dateTo) : undefined,
      amountMin !== undefined ? gte(walletTransaction.amount, amountMin) : undefined,
      amountMax !== undefined ? lte(walletTransaction.amount, amountMax) : undefined,
    ].filter(Boolean);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ tx: walletTransaction, walletUserId: wallet.userId })
        .from(walletTransaction)
        .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(where)
        .orderBy(desc(walletTransaction.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(walletTransaction)
        .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(where),
    ]);
    return {
      rows: rows.map(({ tx, walletUserId }) => ({
        id: tx.id,
        userId: walletUserId,
        type: tx.type,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        rail: tx.rail ?? null,
        createdAt: tx.createdAt,
      })),
      total: Number(n),
    };
  }

  async getTransaction(id: string) {
    const [row] = await this.drizzle.db
      .select({ tx: walletTransaction, walletUserId: wallet.userId })
      .from(walletTransaction)
      .innerJoin(wallet, eq(walletTransaction.walletId, wallet.id))
      .where(eq(walletTransaction.id, id));
    if (!row) return null;
    const { tx, walletUserId } = row;
    return {
      id: tx.id,
      userId: walletUserId,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      rail: tx.rail ?? null,
      createdAt: tx.createdAt,
      providerName: tx.providerName ?? null,
      providerRefId: tx.providerRefId ?? null,
      reviewedBy: tx.reviewedBy ?? null,
      reviewedAt: tx.reviewedAt ?? null,
      reviewReason: tx.reviewReason ?? null,
    };
  }
}
