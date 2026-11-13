import * as z from 'zod';
import { createToken, type Token } from './token.js';
import type { IdentityReader } from './identity-reader.js';
import type { Player } from '../schemas/player.js';
import { UuidSchema } from '../schemas/common.js';

/**
 * What another module may know about an account: its display identity, its role, and whether it
 * may play. Owned and bound by the identity module (it owns `user`), so chat, social and the
 * admin guard read accounts here instead of joining the identity and profile tables. A service
 * running on a database of its own binds an implementation that calls the identity service's
 * internal API (ADR-0052) and caches each answer briefly; that one throws when the call fails,
 * so a caller deciding access fails closed instead of reading "no such account".
 */
export const AccountSchema = z.object({
  userId: z.string(),
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.string(),
  isActive: z.boolean(),
  /**
   * True while `PLAY_ELIGIBILITY.checkPlay` would refuse the account (RG block, closed,
   * suspended, inactive or banned). The reason stays with identity: it is RG data.
   */
  excluded: z.boolean(),
  /** Null for an account with no player profile (staff, or a player not provisioned yet). */
  player: z
    .object({
      playerId: z.string(),
      /** Suspended or closed: out of the social graph. Self-exclusion shows only as `excluded`. */
      closed: z.boolean(),
      lastSeenAt: z.coerce.date().nullable(),
      allowFriendRequests: z.boolean(),
      showOnlineStatusToFriends: z.boolean(),
    })
    .nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

/** A player a search or a mention finds: only what is shown next to the name. */
export const PlayerMatchSchema = AccountSchema.pick({
  userId: true,
  username: true,
  avatarUrl: true,
});
export type PlayerMatch = z.infer<typeof PlayerMatchSchema>;

export const PLAYER_SEARCH_MAX_LIMIT = 50;

export type PlayerSearch = {
  /** Matched case-insensitively anywhere in the username; prefix matches come first. */
  query: string;
  excludeUserId: string;
  limit: number;
};

export type AccountReadOptions = {
  /**
   * Skip any cache. Set by an access decision that must see a demotion, a deactivation or an
   * exclusion on the very next call: the admin guard, and creating or accepting an invite.
   */
  fresh?: boolean;
};

export type AccountReader = {
  /**
   * Keyed by user id as passed (ids match ignoring case). An id that names no account is absent:
   * the caller shows it as unknown.
   */
  getAccounts(
    userIds: readonly string[],
    options?: AccountReadOptions,
  ): Promise<Map<string, Account>>;
  /** The player whose username matches exactly, ignoring case. */
  findPlayerByUsername(username: string): Promise<PlayerMatch | null>;
  /** Players (role `player`, with a profile) whose username contains `query`. */
  searchPlayers(search: PlayerSearch): Promise<PlayerMatch[]>;
  findUserIdByPlayerId(playerId: Player['id']): Promise<string | null>;
};

export const ACCOUNT_READER: Token<AccountReader> = createToken<AccountReader>('ACCOUNT_READER');

/** The identity service's internal routes behind {@link AccountReader}, under `/internal/v1`. */
export const ACCOUNT_READER_ROUTES = {
  accounts: '/identity/accounts',
  byUsername: '/identity/accounts/by-username',
  search: '/identity/accounts/search',
  byPlayer: '/identity/accounts/by-player',
} as const;

// A batch the size of a busy room's member list; a caller splits a bigger one.
export const ACCOUNTS_BATCH_MAX = 500;

/** Request and reply of each route in {@link ACCOUNT_READER_ROUTES}, for the server and the client. */
export const AccountReaderWire = {
  accounts: {
    input: z.object({ userIds: z.array(UuidSchema).max(ACCOUNTS_BATCH_MAX) }),
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

/**
 * The player-id lookups chat and social enrich events with, read through accounts. Best effort
 * like `getPlayerIdByUserIdSafe`: a failed read resolves to null instead of failing the action.
 */
export function playerIdsOf(
  reader: AccountReader,
): Pick<IdentityReader, 'getPlayerIdByUserIdSafe' | 'getPlayerIdsByUserIdsSafe'> {
  const lookup = async (userIds: readonly string[]) => {
    const accounts = await reader.getAccounts(userIds).catch(() => new Map<string, Account>());
    return new Map(userIds.map((id) => [id, accounts.get(id)?.player?.playerId ?? null]));
  };
  return {
    getPlayerIdByUserIdSafe: async (userId) => (await lookup([userId])).get(userId) ?? null,
    getPlayerIdsByUserIdsSafe: lookup,
  };
}
