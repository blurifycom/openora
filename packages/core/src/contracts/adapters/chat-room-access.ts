import { createToken, type Token } from './token.js';

export type ChatRoomAccess = {
  /** Reads through `tx` when given, so a check inside a money transaction sees its snapshot. */
  verifyRoomAccess(roomId: string, viewerId: string, tx?: unknown): Promise<void>;
};

export const CHAT_ROOM_ACCESS: Token<ChatRoomAccess> = createToken('CHAT_ROOM_ACCESS');
