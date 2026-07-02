import type {
  AdminPlayerSummary,
  AdminTxDetail,
  AdminTxRow,
  AdminUserDirectory,
  AdminUserRow,
  AdminWalletReporting,
} from '@blurifycom/core/contracts';
import { makeNotFoundError } from '@blurifycom/core/server';
import type { TransactionFilter } from '../schemas/index.js';

export const UserNotFoundError = makeNotFoundError('User');
export const TransactionNotFoundError = makeNotFoundError('Transaction');

function toAdminUser(r: AdminUserRow) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    isActive: r.isActive,
    role: r.role,
    failedLoginAttempts: r.failedLoginAttempts,
    lockoutUntil: r.lockoutUntil ? r.lockoutUntil.toISOString() : undefined,
  };
}

function toAdminTransaction(r: AdminTxRow, player?: AdminPlayerSummary) {
  return {
    id: r.id,
    userId: r.userId,
    type: r.type,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    rail: r.rail,
    playerEmail: player?.email ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function toAdminTransactionDetail(r: AdminTxDetail, player?: AdminPlayerSummary) {
  return {
    ...toAdminTransaction(r, player),
    playerUsername: player?.username ?? null,
    playerKycStatus: player?.kycStatus ?? null,
    providerRefId: r.providerRefId,
    providerName: r.providerName,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    reviewReason: r.reviewReason,
  };
}

export class BackofficeService {
  constructor(
    private readonly users: AdminUserDirectory,
    private readonly reporting: AdminWalletReporting,
  ) {}

  async getStats() {
    const [totalUsers, totals] = await Promise.all([this.users.count(), this.reporting.totals()]);
    return {
      totalUsers,
      activeUsers: totalUsers,
      totalDeposits: totals.deposits,
      totalWithdrawals: totals.withdrawals,
      totalBonusClaimed: 0,
    };
  }

  async listUsers(page: number, limit: number, search?: string) {
    const { rows, total } = await this.users.list({ page, limit, search });
    return { items: rows.map(toAdminUser), total, page, limit };
  }

  async getUser(userId: string) {
    const row = await this.users.get(userId);
    if (!row) throw new UserNotFoundError(userId);
    return toAdminUser(row);
  }

  async updateUser(userId: string, data: { isActive?: boolean; role?: string }, actorId: string) {
    const row = await this.users.update(userId, data, actorId);
    if (!row) throw new UserNotFoundError(userId);
    return toAdminUser(row);
  }

  async listTransactions(filters: TransactionFilter) {
    const {
      page,
      limit,
      userId,
      type,
      currency,
      rail,
      status,
      dateFrom,
      dateTo,
      amountMin,
      amountMax,
      player,
    } = filters;

    // `userId` = exact wallet.userId match; `player` = free-text resolved to ids.
    // When both are set the result is their intersection.
    let userIds: string[] | undefined;
    if (player) {
      const resolved = await this.users.findPlayerIds(player);
      userIds = userId ? resolved.filter((id) => id === userId) : resolved;
      if (userIds.length === 0) return { items: [], total: 0, page, limit };
    } else if (userId) {
      userIds = [userId];
    }

    const { rows, total } = await this.reporting.listTransactions({
      page,
      limit,
      userIds,
      type,
      currency,
      rail,
      status,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      amountMin,
      amountMax,
    });

    const players = await this.lookupPlayerMap(rows.map((r) => r.userId));
    return {
      items: rows.map((r) => toAdminTransaction(r, players.get(r.userId))),
      total,
      page,
      limit,
    };
  }

  async getTransaction(id: string) {
    const row = await this.reporting.getTransaction(id);
    if (!row) throw new TransactionNotFoundError(id);
    const players = await this.lookupPlayerMap([row.userId]);
    return toAdminTransactionDetail(row, players.get(row.userId));
  }

  private async lookupPlayerMap(userIds: string[]): Promise<Map<string, AdminPlayerSummary>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const summaries = await this.users.lookupPlayers(unique);
    return new Map(summaries.map((s) => [s.userId, s]));
  }
}
