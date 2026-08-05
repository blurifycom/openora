import { createToken } from './token.js';
import type { SystemChatMessage, CommandMetadata } from '../schemas/chat-command.js';

export type { SystemChatMessage as ChatSystemMessage };

export type ChatSystemWriter = {
  postSystemMessage(args: {
    roomId: string | null;
    actorId: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<SystemChatMessage>;
};

export const CHAT_SYSTEM_WRITER = createToken<ChatSystemWriter>('ChatSystemWriter');
