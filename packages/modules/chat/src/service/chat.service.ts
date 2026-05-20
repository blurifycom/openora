import { Injectable, Inject } from '@nestjs/common';
import { type EventBus, EVENT_BUS } from '@oss/core';
import { PrismaService } from '@oss/persistence';
import type { ChatRoom, ChatMessage } from '../schemas/index.js';

export class ChatRoomNotFoundError extends Error {
  constructor(id: string) {
    super(`Chat room not found: ${id}`);
    this.name = 'ChatRoomNotFoundError';
  }
}

export class ChatMessageNotFoundError extends Error {
  constructor(id: string) {
    super(`Chat message not found: ${id}`);
    this.name = 'ChatMessageNotFoundError';
  }
}

export class ChatMessageOwnershipError extends Error {
  constructor(id: string) {
    super(`Not authorized to delete message: ${id}`);
    this.name = 'ChatMessageOwnershipError';
  }
}

function toRoom(record: {
  id: string;
  name: string;
  slug: string;
  isPublic: boolean;
  createdAt: Date;
}): ChatRoom {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    isPublic: record.isPublic,
    createdAt: record.createdAt.toISOString(),
  };
}

function toMessage(record: {
  id: string;
  roomId: string | null;
  userId: string;
  username: string;
  content: string;
  isDeleted: boolean;
  createdAt: Date;
}): ChatMessage {
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
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async listRooms(tenantId?: string): Promise<ChatRoom[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const db = this.prisma as any;
    const rooms = (await db.chatRoom.findMany({
      where: tenantId ? { tenantId } : undefined,
      orderBy: { createdAt: 'asc' },
    })) as Parameters<typeof toRoom>[0][];
    return rooms.map(toRoom);
  }

  async getRoomMessages(roomId: string, limit = 50, before?: string): Promise<ChatMessage[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const db = this.prisma as any;
    const messages = (await db.chatMessage.findMany({
      where: {
        roomId,
        isDeleted: false,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })) as Parameters<typeof toMessage>[0][];
    return messages.map(toMessage);
  }

  async sendRoomMessage(
    userId: string,
    username: string,
    roomId: string,
    content: string,
  ): Promise<ChatMessage> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const db = this.prisma as any;
    const room = (await db.chatRoom.findUnique({ where: { id: roomId } })) as {
      tenantId: string;
    } | null;
    if (!room) throw new ChatRoomNotFoundError(roomId);

    const message = (await db.chatMessage.create({
      data: {
        tenantId: room.tenantId,
        roomId,
        userId,
        username,
        content,
      },
    })) as Parameters<typeof toMessage>[0];

    this.events.emit('chat.message.sent', {
      messageId: message.id,
      roomId,
      userId,
    });

    return toMessage(message);
  }

  async deleteMessage(id: string, userId: string): Promise<{ success: true }> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const db = this.prisma as any;
    const message = (await db.chatMessage.findUnique({ where: { id } })) as {
      userId: string;
    } | null;
    if (!message) throw new ChatMessageNotFoundError(id);
    if (message.userId !== userId) throw new ChatMessageOwnershipError(id);

    await db.chatMessage.update({
      where: { id },
      data: { isDeleted: true },
    });

    return { success: true };
  }

  async getGlobalMessages(tenantId?: string, limit = 50): Promise<ChatMessage[]> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const db = this.prisma as any;
    const messages = (await db.chatMessage.findMany({
      where: {
        roomId: null,
        isDeleted: false,
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })) as Parameters<typeof toMessage>[0][];
    return messages.map(toMessage);
  }

  async sendGlobalMessage(
    userId: string,
    username: string,
    content: string,
    tenantId = 'default',
  ): Promise<ChatMessage> {
    // oxlint-disable-next-line typescript/no-explicit-any
    const db = this.prisma as any;
    const message = (await db.chatMessage.create({
      data: {
        tenantId,
        roomId: null,
        userId,
        username,
        content,
      },
    })) as Parameters<typeof toMessage>[0];

    this.events.emit('chat.message.sent', {
      messageId: message.id,
      roomId: null,
      userId,
    });

    return toMessage(message);
  }
}
