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
 * `OutboxChatSystemWriter` over it, which writes a `chat.system_message.upserted` event on
 * the caller's `tx` (or its own when none is given); the chat module applies that event to
 * its own table.
 *
 * The two differ in when and how a card lands:
 * - Local: the row commits with the caller's transaction, and an id that names another
 *   message fails that transaction.
 * - Outbox: the card lands in chat after the caller's commit, once the event is relayed. The
 *   returned message is built by the writer, so its `createdAt` is the write time, not the
 *   stored row's. An id that names another message cannot fail the committed caller: chat
 *   logs it as an error and acknowledges the event, and the card is not written.
 */
export type ChatSystemWriter = {
  /**
   * Pass `roomId` canonical: null for the global room. The local writer maps the global room's
   * id to null itself; the outbox writer cannot read chat rooms and returns `roomId` as given,
   * so publish to the returned `roomId`, not to `args.roomId`.
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
   * Repeat the post's `roomId`, `actorId` (`CHAT_SYSTEM_AUTHOR_ID` when the post had none) and
   * `username`: chat may apply the update before the post and then creates the card from it.
   * The local writer reads them from the row and ignores these.
   */
  updateSystemMessage(args: {
    messageId: string;
    roomId: string | null;
    actorId: string;
    username?: string;
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<CommandChatMessage>;
};

export const CHAT_SYSTEM_WRITER = createToken<ChatSystemWriter>('ChatSystemWriter');
