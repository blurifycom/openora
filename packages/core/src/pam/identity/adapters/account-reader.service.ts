import { DrizzleService, likeContains, likePrefix } from '@openora/core/server';
import type { Account, AccountReader, Player, PlayerSearch } from '@openora/core/contracts';
import { and, asc, eq, ilike, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '../schema/index.js';
import { playRefusalOf } from '../service/play-eligibility.service.js';

/** {@link AccountReader} on the identity database, read live on every call. */
export class DrizzleAccountReader implements AccountReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async getAccounts(userIds: readonly string[]): Promise<Map<string, Account>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const accounts = await this.select(inArray(user.id, ids));
    return new Map(accounts.map((account) => [account.userId, account]));
  }

  async findPlayerByUsername(username: string): Promise<Account | null> {
    const [account] = await this.select(
      and(sql`lower(${user.username}) = lower(${username})`, eq(user.role, 'player')),
      { playersOnly: true, limit: 1 },
    );
    return account ?? null;
  }

  searchPlayers({ query, excludeUserId, limit }: PlayerSearch): Promise<Account[]> {
    return this.select(
      and(
        ne(user.id, excludeUserId),
        ilike(user.username, likeContains(query)),
        eq(user.role, 'player'),
      ),
      {
        playersOnly: true,
        limit,
        orderBy: [
          sql`case when ${user.username} ilike ${likePrefix(query)} then 0 else 1 end`,
          asc(user.username),
        ],
      },
    );
  }

  async findUserIdByPlayerId(playerId: Player['id']): Promise<string | null> {
    const [row] = await this.drizzle.db
      .select({ userId: player.userId })
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1);
    return row?.userId ?? null;
  }

  private async select(
    where: SQL | undefined,
    options: { playersOnly?: boolean; limit?: number; orderBy?: SQL[] } = {},
  ): Promise<Account[]> {
    const base = this.drizzle.db
      .select({
        userId: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: user.image,
        role: user.role,
        isActive: user.isActive,
        rgBlocked: user.rgBlocked,
        rgBlockedUntil: user.rgBlockedUntil,
        banned: user.banned,
        banExpires: user.banExpires,
        playerId: player.id,
        status: player.status,
        lastSeenAt: player.lastSeenAt,
        allowFriendRequests: player.allowFriendRequests,
        showOnlineStatusToFriends: player.showOnlineStatusToFriends,
      })
      .from(user)
      .leftJoin(player, eq(player.userId, user.id));
    const filtered = base
      .where(options.playersOnly ? and(where, isNotNull(player.id)) : where)
      .$dynamic();
    const ordered = options.orderBy ? filtered.orderBy(...options.orderBy) : filtered;
    const rows = await (options.limit ? ordered.limit(options.limit) : ordered);
    return rows.map((row) => ({
      userId: row.userId,
      username: row.username,
      name: row.name,
      avatarUrl: row.avatarUrl,
      role: row.role,
      isActive: row.isActive,
      playRefusal: playRefusalOf(row, row.status ?? undefined),
      player:
        row.playerId === null || row.status === null
          ? null
          : {
              playerId: row.playerId,
              status: row.status,
              lastSeenAt: row.lastSeenAt,
              allowFriendRequests: row.allowFriendRequests ?? true,
              showOnlineStatusToFriends: row.showOnlineStatusToFriends ?? true,
            },
    }));
  }
}
