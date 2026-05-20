import { Injectable } from '@nestjs/common';
import { PrismaService } from '@oss/persistence';
import type { PlatformStats, AdminUser, AdminTransaction } from '../schemas/index.js';

export class UserNotFoundError extends Error {
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}

// Minimal shape of the combined Prisma client after all partials are merged.
// The generated client is currently empty (schema has no models yet);
// this interface documents the models the backoffice reads at runtime.
interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  isActive?: boolean;
  role?: string;
}

interface TransactionRecord {
  id: string;
  walletId: string;
  type: string;
  amount: { toNumber(): number };
  currency: string;
  status: string;
  createdAt: Date;
  wallet?: { userId: string };
}

interface AggregateResult {
  _sum: Record<string, { toNumber(): number } | null | undefined>;
}

interface PrismaWithAllModels {
  user: {
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findMany(args?: {
      skip?: number;
      take?: number;
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<UserRecord[]>;
    findUnique(args: { where: { id: string } }): Promise<UserRecord | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<UserRecord>;
  };
  walletTransaction: {
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findMany(args?: {
      skip?: number;
      take?: number;
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      include?: Record<string, unknown>;
    }): Promise<TransactionRecord[]>;
    aggregate(args: {
      where?: Record<string, unknown>;
      _sum: Record<string, unknown>;
    }): Promise<AggregateResult>;
  };
}

function toAdminUser(record: UserRecord): AdminUser {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    createdAt: record.createdAt.toISOString(),
    isActive: record.isActive ?? true,
    role: record.role ?? 'user',
  };
}

function toAdminTransaction(record: TransactionRecord): AdminTransaction {
  return {
    id: record.id,
    userId: record.wallet?.userId ?? record.walletId,
    type: record.type,
    amount: record.amount.toNumber(),
    currency: record.currency,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
  };
}

@Injectable()
export class BackofficeService {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): PrismaWithAllModels {
    return this.prisma as unknown as PrismaWithAllModels;
  }

  async getStats(): Promise<PlatformStats> {
    const [totalUsers, depositAgg, withdrawalAgg] = await Promise.all([
      this.db.user.count(),
      this.db.walletTransaction.aggregate({
        where: { type: 'deposit', status: 'completed' },
        _sum: { amount: true },
      }),
      this.db.walletTransaction.aggregate({
        where: { type: 'withdrawal', status: 'completed' },
        _sum: { amount: true },
      }),
    ]);

    const totalDeposits = depositAgg._sum['amount']?.toNumber() ?? 0;
    const totalWithdrawals = withdrawalAgg._sum['amount']?.toNumber() ?? 0;

    return {
      totalUsers,
      activeUsers: totalUsers,
      totalDeposits,
      totalWithdrawals,
      totalBonusClaimed: 0,
    };
  }

  async listUsers(
    page: number,
    limit: number,
    search?: string,
  ): Promise<{ users: AdminUser[]; total: number }> {
    const where: Record<string, unknown> = search
      ? { email: { contains: search, mode: 'insensitive' } }
      : {};

    const [records, total] = await Promise.all([
      this.db.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.db.user.count({ where }),
    ]);

    return { users: records.map(toAdminUser), total };
  }

  async getUser(userId: string): Promise<AdminUser> {
    const record = await this.db.user.findUnique({ where: { id: userId } });
    if (!record) throw new UserNotFoundError(userId);
    return toAdminUser(record);
  }

  async updateUser(
    userId: string,
    data: { isActive?: boolean | undefined; role?: string | undefined },
  ): Promise<AdminUser> {
    const existing = await this.db.user.findUnique({ where: { id: userId } });
    if (!existing) throw new UserNotFoundError(userId);

    const updateData: Record<string, unknown> = {};
    if (data.isActive !== undefined) updateData['isActive'] = data.isActive;
    if (data.role !== undefined) updateData['role'] = data.role;

    const record = await this.db.user.update({
      where: { id: userId },
      data: updateData,
    });
    return toAdminUser(record);
  }

  async listTransactions(
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ transactions: AdminTransaction[]; total: number }> {
    const where: Record<string, unknown> = userId ? { wallet: { userId } } : {};

    const [records, total] = await Promise.all([
      this.db.walletTransaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { wallet: true },
      }),
      this.db.walletTransaction.count({ where }),
    ]);

    return { transactions: records.map(toAdminTransaction), total };
  }
}
