import { randomUUID } from 'node:crypto';
import type { ChatSystemWriter, CommandChatMessage } from '@openora/core/contracts';
import {
  CHAT_SYSTEM_AUTHOR_ID,
  CHAT_SYSTEM_AUTHOR_USERNAME,
  CHAT_SYSTEM_MESSAGE_VERSION,
} from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import type { SystemCardUpsert } from './chat-system-card.service.js';

type CardArgs = Parameters<ChatSystemWriter['updateSystemMessage']>[0];

/**
 * `CHAT_SYSTEM_WRITER` for a service that does not run chat: the card travels as a
 * `chat.system_message.upserted` event written on the caller's transaction, so it exists if
 * and only if the money it reports committed. The returned message is built here, the same
 * shape the local writer returns; the caller still publishes it after commit.
 */
export class OutboxChatSystemWriter implements ChatSystemWriter {
  constructor(private readonly events: EventBus) {}

  postSystemMessage(
    args: Parameters<ChatSystemWriter['postSystemMessage']>[0],
  ): Promise<CommandChatMessage> {
    return this.write(
      { ...args, messageId: args.messageId ?? randomUUID() },
      CHAT_SYSTEM_MESSAGE_VERSION.posted,
    );
  }

  updateSystemMessage(args: CardArgs): Promise<CommandChatMessage> {
    return this.write(args, CHAT_SYSTEM_MESSAGE_VERSION.updated);
  }

  private async write(
    args: CardArgs,
    version: SystemCardUpsert['version'],
  ): Promise<CommandChatMessage> {
    if (args.tx === undefined) {
      throw new Error('OutboxChatSystemWriter needs the caller transaction (tx)');
    }
    if (args.roomId === undefined) {
      throw new Error('OutboxChatSystemWriter needs the card roomId');
    }
    const card: SystemCardUpsert = {
      messageId: args.messageId,
      roomId: args.roomId,
      actorId: args.actorId ?? CHAT_SYSTEM_AUTHOR_ID,
      username: args.username ?? CHAT_SYSTEM_AUTHOR_USERNAME,
      metadata: args.metadata,
      version,
    };
    await this.events.emitInTransaction(args.tx, 'chat.system_message.upserted', card);
    return {
      id: card.messageId,
      roomId: card.roomId,
      actorId: card.actorId,
      userId: card.actorId,
      username: card.username,
      content: '',
      type: 'system',
      metadata: card.metadata,
      isDeleted: false,
      createdAt: new Date().toISOString(),
    };
  }
}
