import { createLogger } from '@openora/core/server';
import {
  CHAT_SYSTEM_AUTHOR_ID,
  CHAT_SYSTEM_AUTHOR_USERNAME,
  CHAT_SYSTEM_MESSAGE_VERSION,
  type ChatContextRooms,
  type DomainEventPayload,
} from '@openora/core/contracts';
import type { ChatSystemCardService } from './chat-system-card.service.js';
import { ChatContextRoomNotFoundError } from './errors/chat-moderation.errors.js';

const logger = createLogger('chat');

export type ContextRoomCommand = DomainEventPayload<'chat.context_room.command_issued'>;

/**
 * Applies a command `OutboxChatContextRoomCommands` issued. Each converges on redelivery: ensure
 * creates the ref's room or returns it, a membership command inserts or deletes the (room, user)
 * row, close sets the room read-only once, and a post inserts on its `messageId` once.
 *
 * A command for a ref that has no room yet throws `ChatContextRoomNotFoundError`, so the broker
 * redelivers it until the ensure has landed, and dead-letters it after its last delivery. It does
 * not create the room itself: it carries no name, and a removal applied before the ensure would
 * be undone by the ensure's member list.
 */
export async function applyContextRoomCommand(
  command: ContextRoomCommand,
  rooms: ChatContextRooms,
  cards: ChatSystemCardService,
): Promise<void> {
  const { ref } = command;
  switch (command.op) {
    case 'ensure': {
      const { room } = await rooms.ensureRoom({
        ref,
        roomId: command.roomId,
        name: command.name,
        memberIds: command.memberIds,
      });
      if (room.id !== command.roomId) {
        logger.warn(
          { ref, roomId: room.id, requestedRoomId: command.roomId },
          'chat context room ensured under an id other than the one the command named',
        );
      }
      return;
    }
    case 'add_member':
      await rooms.addMember({ ref, userId: command.userId });
      return;
    case 'remove_member':
      await rooms.removeMember({ ref, userId: command.userId });
      return;
    case 'close':
      await rooms.close({ ref });
      return;
    case 'post_system_event': {
      const room = await rooms.findRoom(ref);
      if (!room) {
        throw new ChatContextRoomNotFoundError(ref);
      }
      const outcome = await cards.apply({
        messageId: command.messageId,
        roomId: room.id,
        actorId: CHAT_SYSTEM_AUTHOR_ID,
        username: CHAT_SYSTEM_AUTHOR_USERNAME,
        metadata: command.metadata,
        version: CHAT_SYSTEM_MESSAGE_VERSION.posted,
      });
      if (outcome === 'conflict') {
        logger.error(
          { ref, messageId: command.messageId },
          'chat context room post refused: its id names another message',
        );
      }
      return;
    }
  }
}
