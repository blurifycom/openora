import { createToken } from './token.js';
import type { User } from '../schemas/identity.js';
import type { KycStatus, Player } from '../schemas/player.js';

export type IdentityReader = {
  /** Timestamp of the player's most recent session, or null if they have never logged in. Used for inactive evaluation. */
  getLastLoginAt(userId: User['id']): Promise<Date | null>;
  /** Returns player user ids whose most recent session predates sinceDate. Used for the daily inactive batch sweep. */
  getPlayerIdsInactiveSince(sinceDate: Date): Promise<User['id'][]>;
  /** Resolves the player profile id for a given auth user id, or null when no profile exists yet. */
  getPlayerIdByUserId(userId: User['id']): Promise<Player['id'] | null>;
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
};

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
