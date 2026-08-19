import { createToken, type Token } from './token.js';

export type PlayerActivityTracker = {
  touchLastSeen(userId: string): Promise<void>;
};

export const PLAYER_ACTIVITY_TRACKER: Token<PlayerActivityTracker> =
  createToken('PLAYER_ACTIVITY_TRACKER');
