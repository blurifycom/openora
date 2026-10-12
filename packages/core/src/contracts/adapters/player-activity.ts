import { createToken, type Token } from './token.js';

export type PlayerActivityTracker = {
  touchLastSeen(userId: string): Promise<void>;
  /** Players whose last-seen stamp is newer than `since`. Feeds the anonymous usage telemetry. */
  countActiveSince(since: Date): Promise<number>;
};

export const PLAYER_ACTIVITY_TRACKER: Token<PlayerActivityTracker> =
  createToken('PLAYER_ACTIVITY_TRACKER');
