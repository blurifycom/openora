import { createToken, type Token } from './token.js';

export type PlayerActivityTracker = {
  touchLastSeen(userId: string): Promise<void>;
  countActiveSince?(since: Date): Promise<number>;
};

export const PLAYER_ACTIVITY_TRACKER: Token<PlayerActivityTracker> =
  createToken('PLAYER_ACTIVITY_TRACKER');
