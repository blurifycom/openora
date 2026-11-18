import {
  CHAT_SYSTEM_AUTHOR_ID,
  CHAT_SYSTEM_AUTHOR_USERNAME,
  CHAT_SYSTEM_MESSAGE_VERSION,
  type ChatContextRooms,
  type DomainEventPayload,
} from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import type { ChatSystemCardService } from './chat-system-card.service.js';
import {
  ChatContextRoomIdConflictError,
  ChatContextRoomNotFoundError,
  ChatSystemCardRefusedError,
} from './errors/chat-moderation.errors.js';

export type ContextRoomCommand = DomainEventPayload<'chat.context_room.command_issued'>;

type ContextRoomCommandDeps = {
  drizzle: DrizzleService;
  rooms: ChatContextRooms;
  cards: ChatSystemCardService;
};

/**
 * Applies a command `OutboxChatContextRoomCommands` issued. Each converges on redelivery: ensure
 * creates the ref's room or returns it, adding members only to an open room, close sets the room
 * read-only once, and a post inserts on its `messageId` once, stamped with `issuedAt`.
 *
 * Commands are not applied in issue order. One that cannot apply yet or ever throws, so the
 * broker redelivers it and dead-letters it after its last delivery: a post or close for a ref
 * with no room yet (it waits for its ensure), an ensure naming another room id than the ref's
 * (rolled back, nobody joins), a post whose id names another message or whose room is deleted.
 */
export async function applyContextRoomCommand(
  command: ContextRoomCommand,
  { drizzle, rooms, cards }: ContextRoomCommandDeps,
  issuedAt?: Date,
): Promise<void> {
  const { ref } = command;
  switch (command.op) {
    case 'ensure': {
      const ensured = await drizzle.db.transaction(async (tx) => {
        const write = await rooms.ensureRoom({ ...command, tx });
        if (write.room.id !== command.roomId) {
          throw new ChatContextRoomIdConflictError(ref, write.room.id, command.roomId);
        }
        return write;
      });
      await ensured.afterCommit();
      return;
    }
    case 'close':
      await rooms.close({ ref });
      return;
    case 'post_system_event': {
      const room = await rooms.findRoom(ref);
      if (!room) {
        throw new ChatContextRoomNotFoundError(ref);
      }
      const outcome = await cards.apply(
        {
          messageId: command.messageId,
          roomId: room.id,
          actorId: CHAT_SYSTEM_AUTHOR_ID,
          username: CHAT_SYSTEM_AUTHOR_USERNAME,
          metadata: command.metadata,
          version: CHAT_SYSTEM_MESSAGE_VERSION.posted,
        },
        issuedAt,
      );
      if (outcome === 'conflict' || outcome === 'room-gone') {
        throw new ChatSystemCardRefusedError(command.messageId, outcome);
      }
      return;
    }
  }
}
