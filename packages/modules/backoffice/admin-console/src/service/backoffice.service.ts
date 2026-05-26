import { Injectable } from '@nestjs/common';
import { createDomainError } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { eq, ilike, count, sum, and, desc } from 'drizzle-orm';
import { user } from '@oss/modules/platform/identity/schema';
import { wallet, walletTransaction } from '@oss/modules/player/wallet/schema';
import type { PlatformStats, AdminUser, AdminTransaction } from '../schemas/index.js';

export const UserNotFoundError = createDomainError(
  'UserNotFoundError',
  (userId: string) => `User not found: ${userId}`,
);

@Injectable()
export class BackofficeService {
  constructor(private readonly drizzle: DrizzleService) {}

  async getStats(): Promise<PlatformStats> {
    const db = this.drizzle.db;
    const [userCount, depositSum, withdrawalSum] = await Promise.all([
      db.select({ n: count() }).from(user).then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.type, 'deposit'),
            eq(walletTransaction.status, 'completed'),
          ),
        )
        .then(([r]) => Number(r?.total ?? 0)),
      db
        .select({ total: sum(walletTransaction.amount) })
        .from(walletTransaction)
        .where(
          and(
            eq(walletTransaction.type, 'withdrawal'),
            eq(walletTransaction.status, 'completed'),
          ),
        )
        .then(([r]) => Number(r?.total ?? 0)),
    ]);
    return {
      totalUsers: userCount,
      activeUsers: userCount,
      totalDeposits: depositSum,
      totalWithdrawals: withdrawalSum,
      totalBonusClaimed: 0,
    };
  }

  async listUsers(
    page: number,
    limit: number,
    search?: string,
  ): Promise<{ users: AdminUser[]; total: number }> {
    const db = this.drizzle.db;
    const whereClause = search ? ilike(user.email, `%${search}%`) : undefined;
    const [records, [{ n }]] = await Promise.all([
      db
        .select()
        .from(user)
        .where(whereClause)
        .orderBy(desc(user.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ n: count() }).from(user).where(whereClause),
    ]);
    return {
      users: records.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name ?? null,
        createdAt: r.createdAt.toISOString(),
        isActive: r.isActive,
        role: r.role ?? 'user',
      })),
      total: Number(n),
    };
  }

  async getUser(userId: string): Promise<AdminUser> {
    const [record] = await this.drizzle.db.select().from(user).where(eq(user.id, userId));
    if (!record) throw new UserNotFoundError(userId);
    return {
      id: record.id,
      email: record.email,
      name: record.name ?? null,
      createdAt: record.createdAt.toISOString(),
      isActive: record.isActive,
      role: record.role ?? 'user',
    };
  }

  async updateUser(
    userId: string,
    data: { isActive?: boolean; role?: string },
  ): Promise<AdminUser> {
    const [existing] = await this.drizzle.db.select().from(user).where(eq(user.id, userId));
    if (!existing) throw new UserNotFoundError(userId);
    const patch: Partial<typeof user.$inferInsert> = {};
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    if (data.role !== undefined) patch.role = data.role;
    const [record] = await this.drizzle.db
      .update(user)
      .set(patch)
      .where(eq(user.id, userId))
      .returning();
    return {
      id: record!.id,
      email: record!.email,
      name: record!.name ?? null,
      createdAt: record!.createdAt.toISOString(),
      isActive: record!.isActive,
      role: record!.role ?? 'user',
    };
  }

  async listTransactions(
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ transactions: AdminTransaction[]; total: number }> {
    const db = this.drizzle.db;
    const whereClause = userId ? eq(wallet.userId, userId) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select({ tx: walletTransaction, walletUserId: wallet.userId })
        .from(walletTransaction)
        .leftJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(whereClause)
        .orderBy(desc(walletTransaction.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ n: count() })
        .from(walletTransaction)
        .leftJoin(wallet, eq(walletTransaction.walletId, wallet.id))
        .where(whereClause),
    ]);
    return {
      transactions: rows.map(({ tx, walletUserId }) => ({
        id: tx.id,
        userId: walletUserId ?? tx.walletId,
        type: tx.type,
        amount: Number(tx.amount),
        currency: tx.currency,
        status: tx.status,
        createdAt: tx.createdAt.toISOString(),
      })),
      total: Number(n),
    };
  }
}
