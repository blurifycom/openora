import { and, eq, isNull } from 'drizzle-orm';
import { findOneOrThrow, serializeRow, DrizzleService } from '@openora/core/server';
import type { AuditWritePort, ClientMeta, RealtimeTransport, Uuid } from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type { ChatMessage } from '../contract/index.js';
import { chatMessage } from '../schema/index.js';
import { ChatMessageNotFoundError } from './errors/chat-moderation.errors.js';
export { ChatMessageNotFoundError } from './errors/chat-moderation.errors.js';

function toMessage(record: typeof chatMessage.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

function toPublicMessage(record: typeof chatMessage.$inferSelect): ChatMessage {
  return toMessage(record) as ChatMessage;
}

export class ChatMessageModerationService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly transport: RealtimeTransport,
    private readonly audit: AuditWritePort,
  ) {}

  async deleteMessage(
    id: ChatMessage['id'],
    actorId: Uuid,
    meta?: ClientMeta,
    actorType: 'admin' | 'player' = 'admin',
  ) {
    const message = findOneOrThrow(
      await this.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id)),
      new ChatMessageNotFoundError(id),
    );
    if (!message.isDeleted) {
      await this.drizzle.db
        .update(chatMessage)
        .set({ isDeleted: true, deletedAt: new Date() })
        .where(and(eq(chatMessage.id, id), isNull(chatMessage.deletedAt)));
      void Promise.resolve(
        this.transport.remove(chatChannel(message.roomId), {
          ...toPublicMessage(message),
          isDeleted: true,
        }),
      );
    }
    await this.audit.record({
      actorId,
      actorType,
      action: 'chat.message.deleted',
      resourceType: 'chat_message',
      resourceId: id,
      before: { isDeleted: message.isDeleted, roomId: message.roomId, userId: message.userId },
      after: { isDeleted: true },
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true } as const;
  }
}
