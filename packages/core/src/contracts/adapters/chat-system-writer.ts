import { createToken } from './token.js';
import type {
  SystemChatMessage,
  CommandChatMessage,
  CommandMetadata,
} from '../schemas/chat-command.js';

export type { SystemChatMessage as ChatSystemMessage };
export type { CommandChatMessage };

export type ChatSystemWriter = {
  /**
   * The returned `roomId` is canonical (null for the global room); publish to it, not to `args.roomId`.
   * Omit `actorId` and `username` for a message no player wrote; it is attributed to `CHAT_SYSTEM_AUTHOR_ID`.
   */
  postSystemMessage(args: {
    roomId: string | null;
    actorId?: string;
    username?: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<SystemChatMessage>;
  updateSystemMessage(args: {
    messageId: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<CommandChatMessage>;
};

export const CHAT_SYSTEM_WRITER = createToken<ChatSystemWriter>('ChatSystemWriter');
