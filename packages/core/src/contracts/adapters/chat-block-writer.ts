import * as z from 'zod';
import type { User } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';
import { UuidSchema, type Uuid } from '../schemas/common.js';

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
  /** Ids of the users holding an active block on `userId`; ignores are not included. */
  getBlockerIds(userId: User['id']): Promise<string[]>;
  /** Checks the relationship on the caller's transaction before a money mutation. */
  isBlocked(tx: unknown, blockerId: string, blockedId: string): Promise<boolean>;
};

// Shared by block mutations and money-transfer authorization checks.
export function chatBlockLockKey(blockerId: string, blockedId: string): string {
  return `chat-block:${blockerId}:${blockedId}`;
}

export const CHAT_BLOCK_WRITER: Token<ChatBlockWriter> = createToken('CHAT_BLOCK_WRITER');

/** The read a module outside chat needs (player search, mentions), apart from the writes. */
export type ChatBlockReader = Pick<
  ChatBlockWriter,
  'getExcludedUserIds' | 'getBlockedUserIds' | 'getBlockerIds'
>;

export const CHAT_BLOCK_READER: Token<ChatBlockReader> = createToken('CHAT_BLOCK_READER');

/**
 * The chat service's internal routes behind {@link ChatBlockReader}, under `/internal/v1`. A
 * service that does not load chat binds a reader that calls them (ADR-0060).
 */
export const CHAT_BLOCK_READER_ROUTES = {
  excluded: '/chat/blocks/excluded',
  blocked: '/chat/blocks/blocked',
  blockers: '/chat/blocks/blockers',
} as const;

const blockReadWire = {
  input: z.object({ userId: UuidSchema }),
  output: z.object({ userIds: z.array(UuidSchema) }),
} as const;

/** Request and reply of each route in {@link CHAT_BLOCK_READER_ROUTES}, for the server and the client. */
export const ChatBlockReaderWire = {
  excluded: blockReadWire,
  blocked: blockReadWire,
  blockers: blockReadWire,
} as const;
