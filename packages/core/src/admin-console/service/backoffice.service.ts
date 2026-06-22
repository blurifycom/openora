import type {
  AdminTxRow,
  AdminUserDirectory,
  AdminUserRow,
  AdminWalletReporting,
} from '@blurifycom/core/contracts';
import { makeNotFoundError } from '@blurifycom/core/server';
import type { AdminTransaction, AdminUser, PlatformStats } from '../schemas/index.js';

export const UserNotFoundError = makeNotFoundError('User');

function toAdminUser(r: AdminUserRow): AdminUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    isActive: r.isActive,
    role: r.role,
  };
}

function toAdminTransaction(r: AdminTxRow): AdminTransaction {
  return {
    id: r.id,
    userId: r.userId,
    type: r.type,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

// Reads peer modules only via /schema + ports - keeps it a clean, extractable module. See ADR-0017/0025.
export class BackofficeService {
  constructor(
    private readonly users: AdminUserDirectory,
    private readonly reporting: AdminWalletReporting,
  ) {}

  async getStats(): Promise<PlatformStats> {
    const [totalUsers, totals] = await Promise.all([this.users.count(), this.reporting.totals()]);
    return {
      totalUsers,
      activeUsers: totalUsers,
      totalDeposits: totals.deposits,
      totalWithdrawals: totals.withdrawals,
      totalBonusClaimed: 0,
    };
  }

  async listUsers(
    page: number,
    limit: number,
    search?: string,
  ): Promise<{ items: AdminUser[]; total: number; page: number; limit: number }> {
    const { rows, total } = await this.users.list({ page, limit, search });
    return { items: rows.map(toAdminUser), total, page, limit };
  }

  async getUser(userId: string): Promise<AdminUser> {
    const row = await this.users.get(userId);
    if (!row) throw new UserNotFoundError(userId);
    return toAdminUser(row);
  }

  async updateUser(
    userId: string,
    data: { isActive?: boolean; role?: string },
  ): Promise<AdminUser> {
    const row = await this.users.update(userId, data);
    if (!row) throw new UserNotFoundError(userId);
    return toAdminUser(row);
  }

  async listTransactions(
    page: number,
    limit: number,
    userId?: string,
  ): Promise<{ items: AdminTransaction[]; total: number; page: number; limit: number }> {
    const { rows, total } = await this.reporting.listTransactions({ page, limit, userId });
    return { items: rows.map(toAdminTransaction), total, page, limit };
  }
}
