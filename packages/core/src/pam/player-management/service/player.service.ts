import {
  makeNotFoundError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  sumInPivot,
  withAdvisoryXactLock,
  createLogger,
} from '@openora/core/server';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import {
  normalizeKycStatus,
  type PlayerStatus,
  type KycStatus,
  type Player,
  type User,
  type TagKey,
  type PlayerSortBy,
  type PaginationOptions,
  type AdminUserDirectory,
  type AdminGameReporting,
  type ChatBlockReader,
  type SessionCommands,
  type UserCommands,
  type PlayerActivityTracker,
  type ExchangeRateReader,
  type WalletReader,
} from '@openora/core/contracts';
import { eq, ilike, count, or, and, gte, asc, desc, sql, inArray, isNull, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import { playerTag, tag } from '@openora/core/pam/schema/tag';
import { toPlayer, fetchIdentityByUserId } from '../../shared/player-mapper.js';
import type { PlayerSearchResult, PlayerProfileCard } from '../contract/index.js';

const logger = createLogger('player-management');

export const PlayerNotFoundError = makeNotFoundError('Player');
const BLOCKING_PLAYER_STATUSES = new Set<PlayerStatus>(['suspended', 'closed']);

const accountManager = alias(user, 'account_manager');

const playersWithTags = (db: DrizzleDb) =>
  db
    .select({
      player,
      email: user.email,
      username: user.username,
      accountManager: {
        userId: accountManager.id,
        name: accountManager.name,
        isActive: accountManager.isActive,
      },
      tags: sql<
        string[]
      >`coalesce(array_agg(${tag.key}::text) filter (where ${tag.key} is not null), '{}'::text[])`,
    })
    .from(player)
    .leftJoin(user, eq(user.id, player.userId))
    .leftJoin(playerTag, and(eq(playerTag.playerId, player.id), isNull(playerTag.removedAt)))
    .leftJoin(tag, eq(tag.id, playerTag.tagId))
    .leftJoin(accountManager, eq(accountManager.id, player.accountManagerId))
    .groupBy(
      player.id,
      user.email,
      user.username,
      accountManager.id,
      accountManager.name,
      accountManager.isActive,
    );

const toTaggedPlayer = (row: Awaited<ReturnType<typeof playersWithTags>>[number]) => ({
  ...toPlayer(row.player, row.email ?? '', row.username ?? ''),
  tags: row.tags as TagKey[],
  accountManager: row.accountManager,
});

export function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class PlayerService implements PlayerActivityTracker {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly userDirectory: AdminUserDirectory,
    private readonly gameReporting: AdminGameReporting,
    private readonly blockReader: ChatBlockReader,
    private readonly sessionCommands: SessionCommands,
    private readonly userCommands: UserCommands,
    private readonly walletReader: WalletReader,
    private readonly rates?: ExchangeRateReader,
  ) {}

  async refreshTotalDeposits(userId: User['id']): Promise<boolean> {
    return this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, `player_total_deposits:${userId}`, async () => {
        const [current] = await tx
          .select({ id: player.id, currency: player.currency })
          .from(player)
          .where(eq(player.userId, userId));
        if (!current) {
          return true;
        }
        const depositsByCurrency = await this.walletReader.getDepositsByCurrency(userId, tx);
        const totalDeposits = await sumInPivot(
          depositsByCurrency,
          current.currency,
          this.rates,
          tx,
        );
        if (totalDeposits === null) {
          logger.warn(
            { userId },
            'refreshTotalDeposits: could not price every deposit currency, keeping the stored total',
          );
          return false;
        }
        await tx.update(player).set({ totalDeposits }).where(eq(player.id, current.id));
        return true;
      }),
    );
  }

  async list({
    page,
    limit,
    search,
    status,
    kycStatus,
    tags,
    accountManagerId,
    sortBy,
    sortOrder,
  }: PaginationOptions<
    {
      search?: string;
      status?: PlayerStatus;
      kycStatus?: KycStatus;
      tags?: TagKey[];
      accountManagerId?: User['id'];
    },
    PlayerSortBy
  >) {
    const db = this.drizzle.db;
    const conditions = [];
    if (status) {
      conditions.push(eq(player.status, status));
    }
    if (kycStatus) {
      conditions.push(
        normalizeKycStatus(kycStatus) === 'approved'
          ? inArray(player.kycStatus, ['approved', 'verified'])
          : eq(player.kycStatus, kycStatus),
      );
    }
    if (search) {
      conditions.push(
        or(
          ilike(user.username, `%${search}%`),
          ilike(sql`${player.userId}::text`, search),
          ilike(sql`${player.id}::text`, search),
          ilike(user.email, `%${search}%`),
        ),
      );
    }
    if (accountManagerId) {
      conditions.push(eq(player.accountManagerId, accountManagerId));
    }
    if (tags && tags.length > 0) {
      conditions.push(
        inArray(
          player.id,
          db
            .select({ id: playerTag.playerId })
            .from(playerTag)
            .innerJoin(tag, eq(playerTag.tagId, tag.id))
            .where(and(inArray(tag.key, tags), isNull(playerTag.removedAt))),
        ),
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, [{ n }]] = await Promise.all([
      playersWithTags(db)
        .where(whereClause)
        .orderBy(
          ((sortOrder ?? 'desc') === 'asc' ? asc : desc)(
            {
              createdAt: player.createdAt,
              username: user.username,
              status: player.status,
              kycStatus: player.kycStatus,
              totalWagered: player.totalWagered,
              totalDeposits: player.totalDeposits,
              lastSeenAt: player.lastSeenAt,
              level: player.level,
            }[sortBy ?? 'createdAt'],
          ),
          desc(player.id),
        )
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db
        .select({ n: count() })
        .from(player)
        .leftJoin(user, eq(user.id, player.userId))
        .where(whereClause),
    ]);
    return { items: rows.map(toTaggedPlayer), total: Number(n), page, limit };
  }

  private async fetchOneWithTags(playerId: Player['id']) {
    const row = findOneOrThrow(
      await playersWithTags(this.drizzle.db).where(eq(player.id, playerId)),
      new PlayerNotFoundError(playerId),
    );
    return toTaggedPlayer(row);
  }

  async get(playerId: Player['id']) {
    return this.fetchOneWithTags(playerId);
  }

  async getByUserId(userId: User['id']) {
    const record = findOneOrThrow(
      await this.drizzle.db.select().from(player).where(eq(player.userId, userId)),
      new PlayerNotFoundError(userId),
    );
    const identity = await fetchIdentityByUserId(this.drizzle.db, record.userId);
    return toPlayer(record, identity?.email ?? '', identity?.username ?? '');
  }

  async getExtended(playerId: Player['id']) {
    return this.fetchOneWithTags(playerId);
  }

  async update(
    playerId: Player['id'],
    data: { username?: string; status?: PlayerStatus; level?: number },
    actorId: User['id'],
  ) {
    const patch: Partial<typeof player.$inferInsert> = {};
    if (data.status !== undefined) {
      patch.status = data.status;
    }
    if (data.level !== undefined) {
      patch.level = data.level;
    }

    if (data.username !== undefined) {
      const { userId } = findOneOrThrow(
        await this.drizzle.db
          .select({ userId: player.userId })
          .from(player)
          .where(eq(player.id, playerId)),
        new PlayerNotFoundError(playerId),
      );
      await this.userCommands.setUsername(userId, data.username);
    }
    const before = await this.drizzle.db.transaction(async (trx) => {
      const locked = findOneOrThrow(
        await trx.select().from(player).where(eq(player.id, playerId)).for('update'),
        new PlayerNotFoundError(playerId),
      );
      if (Object.keys(patch).length > 0) {
        await trx.update(player).set(patch).where(eq(player.id, playerId));
      }
      if (data.level !== undefined && data.level !== locked.level) {
        await this.events.emitInTransaction(trx, 'player.level.changed', {
          userId: locked.userId,
          playerId,
          previousLevel: locked.level,
          newLevel: data.level,
          actorId,
        });
      }
      if (data.status !== undefined && data.status !== locked.status) {
        await this.emitStatusTransition(trx, {
          playerId,
          userId: locked.userId,
          actorId,
          previousStatus: locked.status,
          newStatus: data.status,
        });
        await this.userCommands.publishPlayEligibility(locked.userId, trx);
      }
      return locked;
    });

    if (
      data.status !== undefined &&
      data.status !== before.status &&
      BLOCKING_PLAYER_STATUSES.has(data.status)
    ) {
      await this.sessionCommands.revokeAll(before.userId, actorId);
    }

    return this.fetchOneWithTags(playerId);
  }

  async suspendBySystem(userId: User['id']): Promise<void> {
    await this.drizzle.db.transaction(async (trx) => {
      const [locked] = await trx
        .select()
        .from(player)
        .where(eq(player.userId, userId))
        .for('update');
      if (!locked) {
        throw new PlayerNotFoundError(userId);
      }
      if (locked.status === 'self_excluded' || BLOCKING_PLAYER_STATUSES.has(locked.status)) {
        return;
      }
      await trx.update(player).set({ status: 'suspended' }).where(eq(player.id, locked.id));
      await this.events.emitInTransaction(trx, 'player.status.changed', {
        playerId: locked.id,
        userId,
        actorId: null,
        previousStatus: locked.status,
        newStatus: 'suspended',
      });
      await this.userCommands.publishPlayEligibility(userId, trx);
    });
    await this.sessionCommands.revokeAll(userId);
  }

  private async emitStatusTransition(
    trx: DrizzleTx,
    transition: {
      playerId: Player['id'];
      userId: User['id'];
      actorId: User['id'];
      previousStatus: PlayerStatus;
      newStatus: PlayerStatus;
    },
  ): Promise<void> {
    const { playerId, userId, actorId, previousStatus, newStatus } = transition;
    if (newStatus === 'closed') {
      await this.events.emitInTransaction(trx, 'player.account.closed', {
        playerId,
        userId,
        actorId,
      });
    }
    if (previousStatus === 'closed') {
      await this.events.emitInTransaction(trx, 'player.account.reopened', {
        playerId,
        userId,
        actorId,
      });
    }
    await this.events.emitInTransaction(trx, 'player.status.changed', transition);
  }

  async touchLastSeen(userId: Player['userId']): Promise<void> {
    await this.drizzle.db
      .update(player)
      .set({ lastSeenAt: new Date() })
      .where(
        and(
          eq(player.userId, userId),
          or(isNull(player.lastSeenAt), lt(player.lastSeenAt, sql`now() - interval '1 minute'`)),
        ),
      );
  }

  async countActiveSince(since: Date): Promise<number> {
    const [row] = await this.drizzle.db
      .select({ value: count() })
      .from(player)
      .where(gte(player.lastSeenAt, since));
    return row?.value ?? 0;
  }

  async remove(playerId: Player['id'], actorId: User['id']) {
    const before = await this.drizzle.db.transaction(async (trx) => {
      const locked = findOneOrThrow(
        await trx.select().from(player).where(eq(player.id, playerId)).for('update'),
        new PlayerNotFoundError(playerId),
      );
      await trx.update(player).set({ status: 'closed' }).where(eq(player.id, playerId));
      if (locked.status !== 'closed') {
        await this.emitStatusTransition(trx, {
          playerId,
          userId: locked.userId,
          actorId,
          previousStatus: locked.status,
          newStatus: 'closed',
        });
        await this.userCommands.publishPlayEligibility(locked.userId, trx);
      }
      return locked;
    });
    await this.sessionCommands.revokeAll(before.userId, actorId);
    return { success: true };
  }

  async registrationsOverTime(days = 30) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const dayKey = sql<string>`to_char(date_trunc('day', ${player.createdAt}), 'YYYY-MM-DD')`;
    const rows = await this.drizzle.db
      .select({ date: dayKey, n: count() })
      .from(player)
      .where(gte(player.createdAt, since))
      .groupBy(dayKey);
    const countByDay = new Map(rows.map((r) => [r.date, Number(r.n)]));
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const date = toDateKey(d);
      return { date, count: countByDay.get(date) ?? 0 };
    });
  }

  async summary() {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const db = this.drizzle.db;
    const [total, active, newLastWeek, selfExcluded] = await Promise.all([
      db
        .select({ n: count() })
        .from(player)
        .then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(player)
        .where(eq(player.status, 'active'))
        .then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(player)
        .where(gte(player.createdAt, weekAgo))
        .then(([r]) => Number(r?.n ?? 0)),
      db
        .select({ n: count() })
        .from(player)
        .where(eq(player.status, 'self_excluded'))
        .then(([r]) => Number(r?.n ?? 0)),
    ]);
    return { total, active, newLastWeek, selfExcluded };
  }

  async searchPlayers(
    q: string,
    limit: number,
    viewerId: User['id'],
  ): Promise<PlayerSearchResult[]> {
    const ids = await this.userDirectory.findPlayerIds(q, limit);
    if (ids.length === 0) {
      return [];
    }
    const excluded = new Set(await this.blockReader.getExcludedUserIds(viewerId));
    const filteredIds = ids.filter((id) => !excluded.has(id));
    if (filteredIds.length === 0) {
      return [];
    }
    const summaries = await this.userDirectory.lookupPlayers(filteredIds);
    return summaries.map((s) => ({
      userId: s.userId,
      username: s.username,
      avatarUrl: s.avatarUrl,
      level: s.level,
    }));
  }

  async getPlayerProfile(userId: User['id'], viewerId: User['id']): Promise<PlayerProfileCard> {
    const summaries = await this.userDirectory.lookupPlayers([userId]);
    const summary = summaries.find((s) => s.userId === userId);
    if (!summary) {
      throw new PlayerNotFoundError(userId);
    }
    const isSelf = userId === viewerId;
    const stats = isSelf ? await this.gameReporting.getPlayerStats(userId) : null;
    return {
      userId: summary.userId,
      username: summary.username,
      avatarUrl: summary.avatarUrl,
      level: summary.level,
      joinedAt: isSelf ? summary.createdAt.toISOString() : null,
      totalWagered: stats?.totalWagered ?? null,
      totalBets: stats?.totalBets ?? null,
      currency: isSelf ? summary.currency : null,
    };
  }
}
