import { createToken } from './token.js';
import type {
  SystemChatMessage,
  CommandChatMessage,
  CommandMetadata,
} from '../schemas/chat-command.js';

export type { SystemChatMessage as ChatSystemMessage };
export type { CommandChatMessage };

export type ChatSystemWriter = {
  postSystemMessage(args: {
    roomId: string | null;
    actorId: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<SystemChatMessage>;
  /** @deprecated Use postSystemMessage; retained for adapter compatibility. */
  postCommandMessage(args: {
    roomId: string | null;
    userId: string;
    username: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<CommandChatMessage>;
  updateCommandMessage(args: {
    messageId: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<CommandChatMessage>;
};

export const CHAT_SYSTEM_WRITER = createToken<ChatSystemWriter>('ChatSystemWriter');
