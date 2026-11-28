import * as z from 'zod';
import { createToken, type Token } from './token.js';
import type { IdentityReader } from './identity-reader.js';
import type { Player } from '../schemas/player.js';
import { UuidSchema } from '../schemas/common.js';

export const AccountSchema = z.object({
  userId: z.string(),
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.string(),
  isActive: z.boolean(),
  excluded: z.boolean(),
  player: z
    .object({
      playerId: z.string(),
      closed: z.boolean(),
      accountClosed: z.boolean().optional(),
      lastSeenAt: z.coerce.date().nullable(),
      allowFriendRequests: z.boolean(),
      showOnlineStatusToFriends: z.boolean(),
    })
    .nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const PlayerMatchSchema = AccountSchema.pick({
  userId: true,
  username: true,
  avatarUrl: true,
});
export type PlayerMatch = z.infer<typeof PlayerMatchSchema>;

export const PLAYER_SEARCH_MAX_LIMIT = 50;

export type PlayerSearch = {
  query: string;
  excludeUserId: string;
  limit: number;
};

export type AccountReadOptions = {
  fresh?: boolean;
  playEligibility?: boolean;
};

export type AccountReader = {
  getAccounts(
    userIds: readonly string[],
    options?: AccountReadOptions,
  ): Promise<Map<string, Account>>;
  findPlayerByUsername(username: string): Promise<PlayerMatch | null>;
  searchPlayers(search: PlayerSearch): Promise<PlayerMatch[]>;
  findUserIdByPlayerId(playerId: Player['id']): Promise<string | null>;
};

export const ACCOUNT_READER: Token<AccountReader> = createToken<AccountReader>('ACCOUNT_READER');

export const ACCOUNT_READER_ROUTES = {
  accounts: '/identity/accounts',
  byUsername: '/identity/accounts/by-username',
  search: '/identity/accounts/search',
  byPlayer: '/identity/accounts/by-player',
} as const;

export const ACCOUNTS_BATCH_MAX = 500;

export const AccountReaderWire = {
  accounts: {
    input: z.object({
      userIds: z.array(UuidSchema).max(ACCOUNTS_BATCH_MAX),
      playEligibility: z.boolean().optional(),
    }),
    output: z.object({ accounts: z.array(AccountSchema) }),
  },
  byUsername: {
    input: z.object({ username: z.string().min(1).max(100) }),
    output: z.object({ account: PlayerMatchSchema.nullable() }),
  },
  search: {
    input: z.object({
      query: z.string().min(1).max(100),
      excludeUserId: UuidSchema,
      limit: z.number().int().min(1).max(PLAYER_SEARCH_MAX_LIMIT),
    }),
    output: z.object({ accounts: z.array(PlayerMatchSchema) }),
  },
  byPlayer: {
    input: z.object({ playerId: UuidSchema }),
    output: z.object({ userId: z.string().nullable() }),
  },
} as const;

export type PlayerIdsLogger = {
  warn(context: { err: unknown; count: number }, message: string): void;
};

export function playerIdsOf(
  reader: AccountReader,
  logger: PlayerIdsLogger,
): Pick<IdentityReader, 'getPlayerIdByUserIdSafe' | 'getPlayerIdsByUserIdsSafe'> {
  const lookup = async (userIds: readonly string[]) => {
    const accounts = await reader.getAccounts(userIds).catch((err: unknown) => {
      logger.warn({ err, count: userIds.length }, 'player id lookup through accounts failed');
      return new Map<string, Account>();
    });
    return new Map(userIds.map((id) => [id, accounts.get(id)?.player?.playerId ?? null]));
  };
  return {
    getPlayerIdByUserIdSafe: async (userId) => (await lookup([userId])).get(userId) ?? null,
    getPlayerIdsByUserIdsSafe: lookup,
  };
}
