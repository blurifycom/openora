import { createToken } from './token.js';

export type IdentityReader = {
  /** Timestamp of the player's most recent session, or null if they have never logged in. Used for inactive evaluation. */
  getLastLoginAt(userId: string): Promise<Date | null>;
  /** Returns player user ids whose most recent session predates sinceDate. Used for the daily inactive batch sweep. */
  getPlayerIdsInactiveSince(sinceDate: Date): Promise<string[]>;
  /** Resolves the player profile id for a given auth user id, or null when no profile exists yet. */
  getPlayerIdByUserId(userId: string): Promise<string | null>;
};

export const IDENTITY_READER = createToken<IdentityReader>('IDENTITY_READER');
