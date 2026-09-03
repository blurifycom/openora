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
  /** Returns other player user ids that have authenticated from the same login IP. */
  getPlayerUserIdsSharingLoginIp(userId: User['id'], ipAddress: string): Promise<User['id'][]>;
  /** True only while the player explicitly opted in and their delivery address remains verified. */
  canReceiveLoginWithdrawalAlerts(userId: User['id']): Promise<boolean>;
};

export const IDENTITY_READER = createToken<IdentityReader>('IDENTITY_READER');
