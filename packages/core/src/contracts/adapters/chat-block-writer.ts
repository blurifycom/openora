import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';

export type ChatBlockWriter = {
  blockUser(blockerId: Uuid, blockedId: Uuid): Promise<unknown>;
  ignoreUser(ignorerId: Uuid, ignoredId: Uuid): Promise<unknown>;
  /**
   * Union of blocked + ignored ids for a viewer - chat-commands uses this to keep
   * blocked/ignored players out of player search results.
   */
  getExcludedUserIds(viewerId: Uuid): Promise<Uuid[]>;
  isBlockedBetween(userA: Uuid, userB: Uuid): Promise<boolean>;
  isBlockedBetweenInTransaction(tx: unknown, userA: Uuid, userB: Uuid): Promise<boolean>;
};

export function chatBlockPairLockKey(userA: Uuid, userB: Uuid): string {
  return `chat-block-pair:${[userA, userB].sort().join(':')}`;
}

export const CHAT_BLOCK_WRITER: Token<ChatBlockWriter> = createToken('CHAT_BLOCK_WRITER');
