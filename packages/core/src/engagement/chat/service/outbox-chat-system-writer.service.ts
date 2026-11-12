import { randomUUID } from 'node:crypto';
import type {
  ChatSystemWriter,
  CommandChatMessage,
  RealtimeTransport,
} from '@openora/core/contracts';
import {
  CHAT_SYSTEM_AUTHOR_ID,
  CHAT_SYSTEM_AUTHOR_USERNAME,
  CHAT_SYSTEM_MESSAGE_VERSION,
} from '@openora/core/contracts';
import type { DrizzleService, EventBus } from '@openora/core/server';
import type { SystemCardUpsert } from './chat-system-card.service.js';
import { publishChatEvent } from './chat.service.js';

type CardArgs = Parameters<ChatSystemWriter['updateSystemMessage']>[0];

/**
 * `CHAT_SYSTEM_WRITER` for a service that does not run chat: the card travels as a
 * `chat.system_message.upserted` event written on the caller's transaction, so it exists if
 * and only if the money it reports committed. Without a `tx` it writes the event in a
 * transaction of its own. The returned message is built here, the same shape the local writer
 * returns. Like the local writer, it publishes only when it owns the transaction; with a `tx` the
 * caller publishes after commit.
 */
export class OutboxChatSystemWriter implements ChatSystemWriter {
  constructor(
    private readonly events: EventBus,
    private readonly drizzle: DrizzleService,
    private readonly transport: RealtimeTransport,
  ) {}

  postSystemMessage(
    args: Parameters<ChatSystemWriter['postSystemMessage']>[0],
  ): Promise<CommandChatMessage> {
    return this.write(
      {
        ...args,
        messageId: args.messageId ?? randomUUID(),
        actorId: args.actorId ?? CHAT_SYSTEM_AUTHOR_ID,
      },
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
    const card: SystemCardUpsert = {
      messageId: args.messageId,
      roomId: args.roomId,
      actorId: args.actorId,
      username: args.username ?? CHAT_SYSTEM_AUTHOR_USERNAME,
      metadata: args.metadata,
      version,
    };
    await (args.tx === undefined
      ? this.drizzle.db.transaction((tx) => this.emit(tx, card))
      : this.emit(args.tx, card));
    const message: CommandChatMessage = {
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
    if (args.tx === undefined) {
      publishChatEvent(this.transport, message.roomId, message);
    }
    return message;
  }

  private emit(tx: unknown, card: SystemCardUpsert): Promise<void> {
    return this.events.emitInTransaction(tx, 'chat.system_message.upserted', card);
  }
}
