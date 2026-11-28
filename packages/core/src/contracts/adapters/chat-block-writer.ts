import * as z from 'zod';
import type { User } from '../schemas/identity.js';
import { createToken, type Token } from './token.js';
import { UuidSchema, type Uuid } from '../schemas/common.js';

export type ChatBlockWriter = {
  blockUser(blockerId: Uuid, blockedId: Uuid): Promise<unknown>;
  ignoreUser(ignorerId: Uuid, ignoredId: Uuid): Promise<unknown>;
  getExcludedUserIds(viewerId: string): Promise<string[]>;
  getBlockedUserIds(viewerId: string): Promise<string[]>;
  getBlockerIds(userId: User['id']): Promise<string[]>;
  isBlocked(tx: unknown, blockerId: string, blockedId: string): Promise<boolean>;
};

export function chatBlockLockKey(blockerId: string, blockedId: string): string {
  return `chat-block:${blockerId}:${blockedId}`;
}

export const CHAT_BLOCK_WRITER: Token<ChatBlockWriter> = createToken('CHAT_BLOCK_WRITER');

export type ChatBlockReader = Pick<
  ChatBlockWriter,
  'getExcludedUserIds' | 'getBlockedUserIds' | 'getBlockerIds'
>;

export const CHAT_BLOCK_READER: Token<ChatBlockReader> = createToken('CHAT_BLOCK_READER');

export const CHAT_BLOCK_READER_ROUTES = {
  excluded: '/chat/blocks/excluded',
  blocked: '/chat/blocks/blocked',
  blockers: '/chat/blocks/blockers',
} as const;

const blockReadWire = {
  input: z.object({ userId: UuidSchema }),
  output: z.object({ userIds: z.array(UuidSchema) }),
} as const;

export const ChatBlockReaderWire = {
  excluded: blockReadWire,
  blocked: blockReadWire,
  blockers: blockReadWire,
} as const;
