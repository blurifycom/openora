import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS, createDomainError } from '@oss/core';
import { DrizzleService } from '@oss/db';
import { eq, and, isNull, lt, desc, asc } from 'drizzle-orm';
import { chatRoom, chatMessage } from '../schema/index.js';
import type { ChatRoom, ChatMessage } from '../schemas/index.js';

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

@Injectable()
export class ChatService {
  constructor(
    private readonly drizzle: DrizzleService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async listRooms(tenantId?: string): Promise<ChatRoom[]> {
    const rooms = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(tenantId ? eq(chatRoom.tenantId, tenantId) : undefined)
      .orderBy(asc(chatRoom.createdAt));
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
    const [room] = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.id, roomId));
    if (!room) throw new ChatRoomNotFoundError(roomId);

    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        tenantId: room.tenantId,
        roomId,
        userId,
        username,
        content,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record!.id,
      roomId,
      userId,
    });

    return toMessage(record!);
  }

  async deleteMessage(id: string, userId: string): Promise<{ success: true }> {
    const [message] = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.id, id));
    if (!message) throw new ChatMessageNotFoundError(id);
    if (message.userId !== userId) throw new ChatMessageOwnershipError(id);

    await this.drizzle.db
      .update(chatMessage)
      .set({ isDeleted: true })
      .where(eq(chatMessage.id, id));

    return { success: true };
  }

  async getGlobalMessages(tenantId?: string, limit = 50): Promise<ChatMessage[]> {
    const conditions = [isNull(chatMessage.roomId), eq(chatMessage.isDeleted, false)];
    if (tenantId) conditions.push(eq(chatMessage.tenantId, tenantId));
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toMessage);
  }

  async sendGlobalMessage(
    userId: string,
    username: string,
    content: string,
    tenantId = 'default',
  ): Promise<ChatMessage> {
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        tenantId,
        roomId: null,
        userId,
        username,
        content,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record!.id,
      roomId: null,
      userId,
    });

    return toMessage(record!);
  }
}
