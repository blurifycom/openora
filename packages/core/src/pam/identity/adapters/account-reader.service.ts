import { DrizzleService, likeContains, likePrefix, mapConcurrent } from '@openora/core/server';
import {
  playRefusalOf,
  type Account,
  type AccountReader,
  type Player,
  type PlayEligibilityPort,
  type PlayerMatch,
  AccountReadOptions,
  type PlayerSearch,
  isPlayRefused,
} from '@openora/core/contracts';
import { and, asc, eq, ilike, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '../schema/index.js';
import { PlayEligibilityService } from '../service/play-eligibility.service.js';

const toMatch = ({ userId, username, avatarUrl }: Account): PlayerMatch => ({
  userId,
  username,
  avatarUrl,
});

const BOUND_PORT_CONCURRENCY = 8;

export class DrizzleAccountReader implements AccountReader {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly playEligibility?: () => PlayEligibilityPort,
  ) {}

  async getAccounts(
    userIds: readonly string[],
    options: AccountReadOptions = {},
  ): Promise<Map<string, Account>> {
    const ids = [...new Set(userIds.map((id) => id.toLowerCase()))];
    if (ids.length === 0) {
      return new Map();
    }
    const accounts = await this.select(inArray(user.id, ids));
    const found = new Map(
      (options.playEligibility ? await this.withOverlayExclusion(accounts) : accounts).map(
        (account) => [account.userId, account],
      ),
    );
    return new Map(
      userIds.flatMap((id) => {
        const account = found.get(id.toLowerCase());
        return account ? [[id, account] as const] : [];
      }),
    );
  }

  async findPlayerByUsername(username: string): Promise<PlayerMatch | null> {
    const [account] = await this.select(
      and(sql`lower(${user.username}) = lower(${username})`, eq(user.role, 'player')),
      { playersOnly: true, limit: 1 },
    );
    return account ? toMatch(account) : null;
  }

  async searchPlayers({ query, excludeUserId, limit }: PlayerSearch): Promise<PlayerMatch[]> {
    const accounts = await this.select(
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
    return accounts.map(toMatch);
  }

  async findUserIdByPlayerId(playerId: Player['id']): Promise<string | null> {
    const [row] = await this.drizzle.db
      .select({ userId: player.userId })
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1);
    return row?.userId ?? null;
  }

  private async withOverlayExclusion(accounts: Account[]): Promise<Account[]> {
    const port = this.playEligibility?.();
    if (!port || port instanceof PlayEligibilityService) {
      return accounts;
    }
    return mapConcurrent(accounts, BOUND_PORT_CONCURRENCY, async (account) =>
      account.excluded || account.player === null
        ? account
        : { ...account, excluded: await isPlayRefused(port, account.userId) },
    );
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
      excluded:
        playRefusalOf({ ...row, banned: row.banned === true, status: row.status ?? null }) !== null,
      player:
        row.playerId === null || row.status === null
          ? null
          : {
              playerId: row.playerId,
              closed: row.status === 'suspended' || row.status === 'closed',
              accountClosed: row.status === 'closed',
              lastSeenAt: row.lastSeenAt,
              allowFriendRequests: row.allowFriendRequests ?? true,
              showOnlineStatusToFriends: row.showOnlineStatusToFriends ?? true,
            },
    }));
  }
}
