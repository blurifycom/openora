import { type EventBus, createDomainError, assertOwnership } from '@oss/core/server';
import type { RealtimeTransport } from '@oss/core/contracts';
import { DrizzleService, findOneOrThrow } from '@oss/core/server';
import { eq, and, isNull, lt, desc, asc } from 'drizzle-orm';
// Sanctioned read-only cross-module table read (display name lives in identity).
// The username shown on a message is resolved server-side from the verified user,
// never from a client-supplied header - so it cannot be spoofed.
import { user } from '@oss/core/pam/schema/identity';
import { chatRoom, chatMessage } from '../schema/index.js';
import type { ChatRoom, ChatMessage } from '../schemas/index.js';

/** Single source for channel names so publishers and subscribers always align. */
export function chatChannel(roomId: string | null): string {
  return roomId ? `chat:room:${roomId}` : 'chat:global';
}

export const ChatRoomNotFoundError = createDomainError(
  'ChatRoomNotFoundError',
  (id: string) => `Chat room not found: ${id}`,
);

export const ChatMessageNotFoundError = createDomainError(
  'ChatMessageNotFoundError',
  (id: string) => `Chat message not found: ${id}`,
);

export const ChatMessageOwnershipError = createDomainError(
  'ChatMessageOwnershipError',
  (id: string) => `Not authorized to delete message: ${id}`,
);

function toRoom(record: typeof chatRoom.$inferSelect): ChatRoom {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    isPublic: record.isPublic,
    createdAt: record.createdAt.toISOString(),
  };
}

function toMessage(record: typeof chatMessage.$inferSelect): ChatMessage {
  return {
    id: record.id,
    roomId: record.roomId,
    userId: record.userId,
    username: record.username,
    content: record.content,
    isDeleted: record.isDeleted,
    createdAt: record.createdAt.toISOString(),
  };
}

export class ChatService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly transport: RealtimeTransport,
  ) {}

  subscribeMessages(roomId: string | null, listener: (message: ChatMessage) => void): () => void {
    return this.transport.subscribe<ChatMessage>(chatChannel(roomId), listener);
  }

  private async resolveDisplayName(userId: string, fallback: string): Promise<string> {
    const [row] = await this.drizzle.db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.name?.trim() || fallback || 'anonymous';
  }

  async listRooms(): Promise<ChatRoom[]> {
    const rooms = await this.drizzle.db.select().from(chatRoom).orderBy(asc(chatRoom.createdAt));
    return rooms.map(toRoom);
  }

  async getRoomMessages(roomId: string, limit = 50, before?: string): Promise<ChatMessage[]> {
    const conditions = [eq(chatMessage.roomId, roomId), eq(chatMessage.isDeleted, false)];
    if (before) conditions.push(lt(chatMessage.createdAt, new Date(before)));
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toMessage);
  }

  async sendRoomMessage(
    userId: string,
    username: string,
    roomId: string,
    content: string,
  ): Promise<ChatMessage> {
    findOneOrThrow(
      await this.drizzle.db.select().from(chatRoom).where(eq(chatRoom.id, roomId)),
      new ChatRoomNotFoundError(roomId),
    );

    const displayName = await this.resolveDisplayName(userId, username);
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        roomId,
        userId,
        username: displayName,
        content,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record!.id,
      roomId,
      userId,
    });

    const message = toMessage(record!);
    // Best-effort push after commit; DB is the system of record for backfill.
    void this.transport.publish(chatChannel(roomId), message);
    return message;
  }

  async deleteMessage(id: string, userId: string): Promise<{ success: true }> {
    const message = findOneOrThrow(
      await this.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id)),
      new ChatMessageNotFoundError(id),
    );
    assertOwnership(message.userId, userId, new ChatMessageOwnershipError(id));

    await this.drizzle.db
      .update(chatMessage)
      .set({ isDeleted: true })
      .where(eq(chatMessage.id, id));

    return { success: true };
  }

  async getGlobalMessages(limit = 50): Promise<ChatMessage[]> {
    const conditions = [isNull(chatMessage.roomId), eq(chatMessage.isDeleted, false)];
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toMessage);
  }

  async sendGlobalMessage(userId: string, username: string, content: string): Promise<ChatMessage> {
    const displayName = await this.resolveDisplayName(userId, username);
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        roomId: null,
        userId,
        username: displayName,
        content,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record!.id,
      roomId: null,
      userId,
    });

    const message = toMessage(record!);
    void this.transport.publish(chatChannel(null), message);
    return message;
  }
}
