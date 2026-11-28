import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type { AccountManager } from '../schemas/player.js';

export type PlayerAccountManagerReader = {
  getByPlayerUserId(userId: Uuid): Promise<AccountManager | null>;
};

export const PLAYER_ACCOUNT_MANAGER_READER: Token<PlayerAccountManagerReader> = createToken(
  'PLAYER_ACCOUNT_MANAGER_READER',
);
