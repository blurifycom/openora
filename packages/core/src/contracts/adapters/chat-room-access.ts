import { createToken, type Token } from './token.js';

export type ChatRoomAccess = {
  verifyRoomAccess(roomId: string, viewerId: string): Promise<void>;
};

export const CHAT_ROOM_ACCESS: Token<ChatRoomAccess> = createToken('CHAT_ROOM_ACCESS');
