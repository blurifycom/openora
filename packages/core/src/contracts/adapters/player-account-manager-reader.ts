import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { AccountManager } from '../schemas/player.js';

/** Read-only seam to a player's account manager, bound by player-management. */
export type PlayerAccountManagerReader = {
  /** Null when the player has no account manager, and when no player has this identity user id. */
  getByPlayerUserId(userId: Uuid): Promise<AccountManager | null>;
};

export const PLAYER_ACCOUNT_MANAGER_READER: Token<PlayerAccountManagerReader> = createToken(
  'PLAYER_ACCOUNT_MANAGER_READER',
);
