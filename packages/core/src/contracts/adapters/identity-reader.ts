import { createToken } from './token.js';
import type { User } from '../schemas/identity.js';
import type { KycStatus, Player } from '../schemas/player.js';

export type IdentityReader = {
  getLastLoginAt(userId: User['id']): Promise<Date | null>;
  getPlayerIdsInactiveSince(sinceDate: Date): Promise<User['id'][]>;
  getPlayerIdByUserId(userId: User['id'], tx?: unknown): Promise<Player['id'] | null>;
  getPlayerIdByUserIdSafe(userId: User['id']): Promise<Player['id'] | null>;
  getPlayerIdsByUserIdsSafe(userIds: User['id'][]): Promise<Map<User['id'], Player['id'] | null>>;
  getPlayerKycStatusByUserId(userId: User['id']): Promise<KycStatus | null>;
  getPlayerUserIdsSharingLoginIp(userId: User['id'], ipAddress: string): Promise<User['id'][]>;
  canReceiveLoginWithdrawalAlerts?(userId: User['id']): Promise<boolean>;
  getUserIdByPlayerId?(playerId: Player['id']): Promise<User['id'] | null>;
  getUserIdsByPlayerIds?(
    playerIds: readonly Player['id'][],
  ): Promise<Map<Player['id'], User['id']>>;
  getPlayerDateOfBirthByUserId?(userId: User['id'], tx?: unknown): Promise<string | null>;
  getPlayerIdsByUserIds?(userIds: readonly User['id'][]): Promise<Map<User['id'], Player['id']>>;
  getLeaderboardNames?(userIds: readonly User['id'][]): Promise<Map<User['id'], LeaderboardName>>;
  getUserContacts?(userIds: readonly User['id'][]): Promise<Map<User['id'], UserContact>>;
  getPlayerFacts?(userIds: readonly User['id'][]): Promise<Map<User['id'], PlayerFacts>>;
};

export type LeaderboardName = { username: string; hideUsername: boolean };
export type UserContact = { name: string | null; email: string };
export type PlayerFacts = {
  country: string | null;
  firstName: string | null;
  lastName: string | null;
  preferredLanguage: string;
};

export const IDENTITY_READER = createToken<IdentityReader>('IDENTITY_READER');

export async function userIdOfPlayer(
  reader: IdentityReader,
  playerId: Player['id'],
): Promise<User['id'] | null> {
  if (!reader.getUserIdByPlayerId) {
    throw new Error('the bound IDENTITY_READER cannot resolve a player id to a user id');
  }
  return reader.getUserIdByPlayerId(playerId);
}

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

export function playerIdsOfUsers(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], Player['id']>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getPlayerIdsByUserIds')(unique(userIds));
}

export function leaderboardNamesOf(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], LeaderboardName>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getLeaderboardNames')(unique(userIds));
}

export function userContactsOf(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], UserContact>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getUserContacts')(unique(userIds));
}

export function playerFactsOf(
  reader: IdentityReader,
  userIds: readonly User['id'][],
): Promise<Map<User['id'], PlayerFacts>> {
  return userIds.length === 0
    ? Promise.resolve(new Map())
    : required(reader, 'getPlayerFacts')(unique(userIds));
}

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
