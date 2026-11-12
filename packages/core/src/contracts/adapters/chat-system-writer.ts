import { createToken } from './token.js';
import type {
  SystemChatMessage,
  CommandChatMessage,
  CommandMetadata,
} from '../schemas/chat-command.js';

export type { SystemChatMessage as ChatSystemMessage };
export type { CommandChatMessage };

/**
 * Writes the system cards a command posts into chat. The chat module binds the local writer,
 * which writes the row inside the caller's `tx`. A service that runs without chat binds
 * `OutboxChatSystemWriter`, which needs `tx` and writes a `chat.system_message.upserted` event
 * on it instead; the chat module applies that event to its own table.
 */
export type ChatSystemWriter = {
  /**
   * The returned `roomId` is canonical (null for the global room); publish to it, not to `args.roomId`.
   * Omit `actorId` and `username` for a message no player wrote; it is attributed to `CHAT_SYSTEM_AUTHOR_ID`.
   * `messageId` lets the caller key the card on its own record (a gift or a rain id), so a later
   * update can find it without storing the id the writer returned. It must be new: an id that
   * already names a message is refused, never overwritten.
   * Never asks `CHAT_CONTEXT_SEND_POLICY`; a player's command posting into a context room asks it first.
   */
  postSystemMessage(args: {
    messageId?: string;
    roomId: string | null;
    actorId?: string;
    username?: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<SystemChatMessage>;
  /**
   * `roomId`, `actorId` and `username` repeat what the card was posted with. The local writer
   * reads them from the row; the outbox writer requires `roomId`, because chat may apply the
   * update before the post and must create the card from it.
   */
  updateSystemMessage(args: {
    messageId: string;
    roomId?: string | null;
    actorId?: string;
    username?: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<CommandChatMessage>;
};

export const CHAT_SYSTEM_WRITER = createToken<ChatSystemWriter>('ChatSystemWriter');
