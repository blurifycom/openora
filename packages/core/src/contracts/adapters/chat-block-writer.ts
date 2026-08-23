import { createToken, type Token } from './token.js';
import type { Uuid } from '../schemas/common.js';

export type ChatBlockWriter = {
  blockUser(blockerId: Uuid, blockedId: Uuid): Promise<unknown>;
  ignoreUser(ignorerId: Uuid, ignoredId: Uuid): Promise<unknown>;
  /**
   * Union of blocked + ignored ids for a viewer - chat-commands uses this to keep
   * blocked/ignored players out of player search results.
   */
  getExcludedUserIds(viewerId: string): Promise<string[]>;
  /** Active block relationships only; ignores do not prevent money transfers. */
  getBlockedUserIds(viewerId: string): Promise<string[]>;
  /** Checks the relationship on the caller's transaction before a money mutation. */
  isBlocked(tx: unknown, blockerId: string, blockedId: string): Promise<boolean>;
};

// Shared by block mutations and money-transfer authorization checks.
export function chatBlockLockKey(blockerId: string, blockedId: string): string {
  return `chat-block:${blockerId}:${blockedId}`;
}

export const CHAT_BLOCK_WRITER: Token<ChatBlockWriter> = createToken('CHAT_BLOCK_WRITER');
