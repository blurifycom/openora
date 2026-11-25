import { createToken } from './token.js';
import type { User } from '../schemas/identity.js';
import type { KycStatus, Player } from '../schemas/player.js';

export type IdentityReader = {
  /** Timestamp of the player's most recent session, or null if they have never logged in. Used for inactive evaluation. */
  getLastLoginAt(userId: User['id']): Promise<Date | null>;
  /** Returns player user ids whose most recent session predates sinceDate. Used for the daily inactive batch sweep. */
  getPlayerIdsInactiveSince(sinceDate: Date): Promise<User['id'][]>;
  /**
   * Resolves the player profile id for a given auth user id, or null when no profile exists yet.
   * Pass the caller's `tx` when enriching an event inside a transaction: the lookup then runs on
   * the same connection instead of holding the tx open while waiting on a second pool connection.
   */
  getPlayerIdByUserId(userId: User['id'], tx?: unknown): Promise<Player['id'] | null>;
  /** Best-effort variant for optional event enrichment; lookup failures resolve to null. */
  getPlayerIdByUserIdSafe(userId: User['id']): Promise<Player['id'] | null>;
  /** Batched, best-effort variant of {@link getPlayerIdByUserIdSafe} for enriching events across many users in one round trip. */
  getPlayerIdsByUserIdsSafe(userIds: User['id'][]): Promise<Map<User['id'], Player['id'] | null>>;
  /** Resolves the player's current KYC status from PAM, or null when no profile exists yet. */
  getPlayerKycStatusByUserId(userId: User['id']): Promise<KycStatus | null>;
  /**
   * Returns other player user ids that have authenticated from the same login IP. Empty when
   * `userId` is not a player: staff sharing an office IP with players is not a multi-account signal.
   */
  getPlayerUserIdsSharingLoginIp(userId: User['id'], ipAddress: string): Promise<User['id'][]>;
  /**
   * True only while the player explicitly opted in and their delivery address remains
   * verified. Optional so an operator's own implementation of this port keeps compiling;
   * a missing implementation reads as opted out, which is the default state anyway.
   */
  canReceiveLoginWithdrawalAlerts?(userId: User['id']): Promise<boolean>;
  /**
   * Resolves a player profile id to its auth user id, or null when no such player exists.
   * Optional so an operator's own implementation of this port keeps compiling; a caller that
   * needs it must fail closed when it is missing rather than treat that as "no such player".
   */
  getUserIdByPlayerId?(playerId: Player['id']): Promise<User['id'] | null>;
  /**
   * {@link getUserIdByPlayerId} for many players in one query, keyed by the player id given; a
   * player id that names no player is absent. Optional for the same reason, and a caller that
   * needs it fails closed the same way.
   */
  getUserIdsByPlayerIds?(
    playerIds: readonly Player['id'][],
  ): Promise<Map<Player['id'], User['id']>>;
  /**
   * The player's declared ISO date of birth, or null when none is stored. Optional so an
   * operator's own implementation keeps compiling; without it a KYC date-of-birth mismatch
   * goes undetected.
   */
  getPlayerDateOfBirthByUserId?(userId: User['id'], tx?: unknown): Promise<string | null>;
  /**
   * The player profile id of each of `userIds`; a user without a profile is absent. Unlike
   * {@link getPlayerIdsByUserIdsSafe} a failed lookup rejects. Optional for the same reason as
   * {@link getUserIdByPlayerId}; a caller fails closed through {@link playerIdsOfUsers}.
   */
  getPlayerIdsByUserIds?(userIds: readonly User['id'][]): Promise<Map<User['id'], Player['id']>>;
  /**
   * What a public leaderboard shows for each of `userIds`: the username and whether the player
   * hides it (false for a user without a player profile). A user id that names no user is absent.
   * Optional; a caller fails closed through {@link leaderboardNamesOf}.
   */
  getLeaderboardNames?(userIds: readonly User['id'][]): Promise<Map<User['id'], LeaderboardName>>;
  /**
   * Name and email of each of `userIds` (staff actors on an audit-style view); an unknown id is
   * absent. Optional; a caller fails closed through {@link userContactsOf}.
   */
  getUserContacts?(userIds: readonly User['id'][]): Promise<Map<User['id'], UserContact>>;
};

export type LeaderboardName = { username: string; hideUsername: boolean };
export type UserContact = { name: string | null; email: string };

export const IDENTITY_READER = createToken<IdentityReader>('IDENTITY_READER');

/**
 * `getUserIdByPlayerId` for a caller that cannot work without it: throws when the bound reader
 * does not implement it, so the caller fails closed instead of reading "no such player".
 */
export async function userIdOfPlayer(
  reader: IdentityReader,
  playerId: Player['id'],
): Promise<User['id'] | null> {
  if (!reader.getUserIdByPlayerId) {
    throw new Error('the bound IDENTITY_READER cannot resolve a player id to a user id');
  }
  return reader.getUserIdByPlayerId(playerId);
}

/** `getUserIdsByPlayerIds` for a caller that cannot work without it; throws like {@link userIdOfPlayer}. */
export async function userIdsOfPlayers(
  reader: IdentityReader,
  playerIds: readonly Player['id'][],
): Promise<Map<Player['id'], User['id']>> {
  if (!reader.getUserIdsByPlayerIds) {
    throw new Error('the bound IDENTITY_READER cannot resolve player ids to user ids');
  }
  return reader.getUserIdsByPlayerIds(playerIds);
}

function required<K extends keyof IdentityReader>(
  reader: IdentityReader,
  method: K,
): NonNullable<IdentityReader[K]> {
  const fn = reader[method];
  if (!fn) {
    throw new Error(`the bound IDENTITY_READER does not implement ${method}`);
  }
  return fn.bind(reader) as NonNullable<IdentityReader[K]>;
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** `getPlayerIdsByUserIds` for a caller that cannot work without it; throws like {@link userIdOfPlayer}. */
export function playerIdsOfUsers(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], Player['id']>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getPlayerIdsByUserIds')(unique(userIds));
}

/** `getLeaderboardNames` for a caller that cannot work without it; throws like {@link userIdOfPlayer}. */
export function leaderboardNamesOf(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], LeaderboardName>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getLeaderboardNames')(unique(userIds));
}

/** `getUserContacts` for a caller that cannot work without it; throws like {@link userIdOfPlayer}. */
export function userContactsOf(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], UserContact>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getUserContacts')(unique(userIds));
}

/**
 * Swaps each row's `userId` for the player id it names (null for a user without a profile), the
 * column a list read once took from a join on the player table.
 */
export async function withPlayerIds<T extends { userId: User['id'] }>(
  reader: IdentityReader,
  rows: readonly T[],
): Promise<(Omit<T, 'userId'> & { playerId: Player['id'] | null })[]> {
  const ids = await playerIdsOfUsers(
    reader,
    rows.map((row) => row.userId),
  );
  return rows.map(({ userId, ...row }) => ({ ...row, playerId: ids.get(userId) ?? null }));
}
