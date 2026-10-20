import { createToken, type Token } from './token.js';

export type PlayerActivityTracker = {
  touchLastSeen(userId: string): Promise<void>;
  /** Players whose last-seen stamp is at or after `since`. Feeds the anonymous usage telemetry; telemetry reports `null` without it. */
  countActiveSince?(since: Date): Promise<number>;
};

export const PLAYER_ACTIVITY_TRACKER: Token<PlayerActivityTracker> =
  createToken('PLAYER_ACTIVITY_TRACKER');
