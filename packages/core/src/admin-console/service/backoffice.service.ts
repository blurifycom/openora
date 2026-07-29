import type {
  AdminGameReporting,
  AdminPlayerActivity,
  AdminPlayerSummary,
  AdminTxDetail,
  AdminTxRow,
  AdminUserDirectory,
  AdminUserListOptions,
  AdminUserRow,
  AdminWalletReporting,
  User,
  UserRole,
  ClientMeta,
} from '@openora/core/contracts';
import { makeNotFoundError, serializeRow } from '@openora/core/server';
import type {
  GamePerformanceFilter,
  PlayerActivityFilter,
  TransactionFilter,
} from '../contract/index.js';

export const UserNotFoundError = makeNotFoundError('User');
export const TransactionNotFoundError = makeNotFoundError('Transaction');

function toAdminUser(r: AdminUserRow) {
  return serializeRow(r, { dateFields: ['createdAt', 'lockoutUntil'] });
}

function toAdminTransaction(r: AdminTxRow, player?: AdminPlayerSummary) {
  return {
    ...serializeRow(r, { dateFields: ['createdAt'] }),
    playerEmail: player?.email ?? null,
  };
}

function toAdminTransactionDetail(r: AdminTxDetail, player?: AdminPlayerSummary) {
  return {
    ...serializeRow(r, { dateFields: ['createdAt', 'reviewedAt'] }),
    playerEmail: player?.email ?? null,
    playerUsername: player?.username ?? null,
    playerKycStatus: player?.kycStatus ?? null,
  };
}

export class BackofficeService {
  constructor(
    private readonly users: AdminUserDirectory,
    private readonly reporting: AdminWalletReporting,
    private readonly gameReporting: AdminGameReporting,
    private readonly playerActivity: AdminPlayerActivity,
  ) {}

  async getStats() {
    const [totalUsers, totals] = await Promise.all([this.users.count(), this.reporting.totals()]);
    return {
      totalUsers,
      activeUsers: totalUsers,
      totalDeposits: totals.deposits,
      totalWithdrawals: totals.withdrawals,
      totalBonusClaimed: '0',
    };
  }

  async listUsers({ page, limit, search, sortBy, sortOrder }: AdminUserListOptions) {
    const { rows, total } = await this.users.list({ page, limit, search, sortBy, sortOrder });
    return { items: rows.map(toAdminUser), total, page, limit };
  }

  async getUser(userId: User['id']) {
    const row = await this.users.get(userId);
    if (!row) {
      throw new UserNotFoundError(userId);
    }
    return toAdminUser(row);
  }

  async updateUser(
    userId: User['id'],
    data: { isActive?: boolean; role?: UserRole },
    actorId: User['id'],
    meta?: ClientMeta,
  ) {
    const row = await this.users.update(userId, data, actorId, meta);
    if (!row) {
      throw new UserNotFoundError(userId);
    }
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
      sortBy,
      sortOrder,
    } = filters;

    // `userId` = exact wallet.userId match; `player` = free-text resolved to ids.
    // When both are set the result is their intersection.
    let userIds: string[] | undefined;
    if (player) {
      const resolved = await this.users.findPlayerIds(player);
      userIds = userId ? resolved.filter((id) => id === userId) : resolved;
      if (userIds.length === 0) {
        return { items: [], total: 0, page, limit };
      }
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
      sortBy,
      sortOrder,
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
    if (!row) {
      throw new TransactionNotFoundError(id);
    }
    const players = await this.lookupPlayerMap([row.userId]);
    return toAdminTransactionDetail(row, players.get(row.userId));
  }

  private async lookupPlayerMap(userIds: string[]): Promise<Map<string, AdminPlayerSummary>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      return new Map();
    }
    const summaries = await this.users.lookupPlayers(unique);
    return new Map(summaries.map((s) => [s.userId, s]));
  }

  // The port's row shape already matches GamePerformanceSchema field-for-field (no
  // Date/Decimal to serialize - volume/revenue are already decimal strings) - no mapping.
  async getGamePerformance(filter: GamePerformanceFilter) {
    return this.gameReporting.listGamePerformance({
      dateFrom: filter.dateFrom ? new Date(filter.dateFrom) : undefined,
      dateTo: filter.dateTo ? new Date(filter.dateTo) : undefined,
      gameType: filter.gameType,
      sortBy: filter.sortBy,
      sortDir: filter.sortDir,
    });
  }

  async getPlayerActivity(filter: PlayerActivityFilter) {
    const portFilter = {
      dateFrom: filter.dateFrom ? new Date(filter.dateFrom) : undefined,
      dateTo: filter.dateTo ? new Date(filter.dateTo) : undefined,
    };
    const [registrationsOverTime, activeUsersTrend, sevenDay, thirtyDay] = await Promise.all([
      this.playerActivity.getRegistrationsOverTime(portFilter),
      this.playerActivity.getActiveUsersTrend(portFilter),
      this.playerActivity.getRetentionCohorts(portFilter, 7),
      this.playerActivity.getRetentionCohorts(portFilter, 30),
    ]);
    return { registrationsOverTime, activeUsersTrend, retention: { sevenDay, thirtyDay } };
  }
}
