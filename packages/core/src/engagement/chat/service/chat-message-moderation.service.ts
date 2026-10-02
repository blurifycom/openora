import { and, eq, isNull } from 'drizzle-orm';
import { createLogger, findOneOrThrow, serializeRow, DrizzleService } from '@openora/core/server';
import type { AuditWritePort, ClientMeta, RealtimeTransport, Uuid } from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type { ChatMessage } from '../contract/index.js';
import { chatMessage } from '../schema/index.js';
import { ChatMessageNotFoundError } from './errors/chat-moderation.errors.js';
export { ChatMessageNotFoundError } from './errors/chat-moderation.errors.js';

const logger = createLogger('chat');

function toTombstone(record: typeof chatMessage.$inferSelect): ChatMessage {
  const message = serializeRow(record, { dateFields: ['createdAt'] });
  const tombstone = { ...message, isDeleted: true };
  return (
    record.type === 'user'
      ? { ...tombstone, content: '', attachment: null }
      : { ...tombstone, actorId: record.userId }
  ) as ChatMessage;
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
    const deleted = await this.drizzle.db.transaction(async (tx) => {
      const message = findOneOrThrow(
        await tx.select().from(chatMessage).where(eq(chatMessage.id, id)),
        new ChatMessageNotFoundError(id),
      );
      const [updated] = await tx
        .update(chatMessage)
        .set({ isDeleted: true, deletedAt: new Date() })
        .where(
          and(
            eq(chatMessage.id, id),
            eq(chatMessage.isDeleted, false),
            isNull(chatMessage.deletedAt),
          ),
        )
        .returning();
      if (!updated) {
        return null;
      }
      await this.audit.recordInTransaction(tx, {
        actorId,
        actorType,
        action: 'chat.message.deleted',
        resourceType: 'chat_message',
        resourceId: id,
        before: { isDeleted: false, roomId: message.roomId, userId: message.userId },
        after: { isDeleted: true },
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
      return updated;
    });
    if (deleted) {
      void Promise.resolve()
        .then(() => this.transport.remove(chatChannel(deleted.roomId), toTombstone(deleted)))
        .catch((err: unknown) => {
          logger.error({ err, messageId: id }, 'chat realtime removal failed');
        });
    }
    return { success: true } as const;
  }
}
