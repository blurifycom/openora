import { createToken, type Token } from './token.js';

export type ChatBlockWriter = {
  blockUser(blockerId: string, blockedId: string): Promise<unknown>;
};

export const CHAT_BLOCK_WRITER: Token<ChatBlockWriter> = createToken('CHAT_BLOCK_WRITER');
