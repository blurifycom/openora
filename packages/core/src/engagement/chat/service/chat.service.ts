import {
  type EventBus,
  createDomainError,
  assertOwnership,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
} from '@openora/core/server';
import type { RealtimeTransport } from '@openora/core/contracts';
import { eq, and, isNull, lt, desc, asc, notInArray } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type { User } from '@openora/core/pam/schema/identity';
import { chatRoom, chatMessage, chatUserBlock } from '../schema/index.js';
import type { ChatRoom, ChatMessage } from '../contract/index.js';
import { moderateContent } from '../moderation/index.js';

export function chatChannel(roomId: ChatRoom['id'] | null) {
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

export const ChatMessageBlockedError = createDomainError(
  'ChatMessageBlockedError',
  () => 'Message blocked: it contains prohibited language',
);

export const ChatSelfBlockError = createDomainError(
  'ChatSelfBlockError',
  () => 'You cannot block yourself',
);

function gateContent(content: string): string {
  const result = moderateContent(content);
  if (!result.ok) throw new ChatMessageBlockedError();
  return result.content;
}

function toRoom(record: typeof chatRoom.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

function toMessage(record: typeof chatMessage.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

export class ChatService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly transport: RealtimeTransport,
  ) {}

  subscribeMessages(
    roomId: ChatRoom['id'] | null,
    listener: (message: ChatMessage) => void,
    viewerId?: User['id'],
  ) {
    let blocked: ReadonlySet<User['id']> | null = viewerId ? null : new Set();
    const pending: ChatMessage[] = [];
    const deliver = (message: ChatMessage) => {
      if (!blocked!.has(message.userId)) listener(message);
    };
    if (viewerId) {
      this.blockedIdsFor(viewerId)
        .catch(() => new Set<User['id']>())
        .then((ids) => {
          blocked = ids;
          for (const message of pending) deliver(message);
          pending.length = 0;
        });
    }
    return this.transport.subscribe<ChatMessage>(chatChannel(roomId), (message) => {
      if (blocked === null) pending.push(message);
      else deliver(message);
    });
  }

  private async blockedIdsFor(viewerId: User['id']) {
    const rows = await this.drizzle.db
      .select({ blockedId: chatUserBlock.blockedId })
      .from(chatUserBlock)
      .where(eq(chatUserBlock.blockerId, viewerId));
    return new Set(rows.map((r) => r.blockedId));
  }

  private async resolveDisplayName(userId: User['id'], fallback: string) {
    const [row] = await this.drizzle.db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.name?.trim() || fallback || 'anonymous';
  }

  async listRooms() {
    const rooms = await this.drizzle.db.select().from(chatRoom).orderBy(asc(chatRoom.createdAt));
    return rooms.map(toRoom);
  }

  async getRoomMessages({
    roomId,
    limit = 50,
    before,
    viewerId,
  }: {
    roomId: ChatRoom['id'];
    limit?: number;
    before?: string;
    viewerId?: User['id'];
  }) {
    const conditions = [eq(chatMessage.roomId, roomId), eq(chatMessage.isDeleted, false)];
    if (before) conditions.push(lt(chatMessage.createdAt, new Date(before)));
    await this.appendBlockFilter(conditions, viewerId);
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toMessage);
  }

  private async appendBlockFilter(conditions: ReturnType<typeof eq>[], viewerId?: User['id']) {
    if (!viewerId) return;
    const blocked = await this.blockedIdsFor(viewerId);
    if (blocked.size > 0) conditions.push(notInArray(chatMessage.userId, [...blocked]));
  }

  async sendRoomMessage({
    userId,
    username,
    roomId,
    content,
  }: {
    userId: User['id'];
    username: string;
    roomId: ChatRoom['id'];
    content: string;
  }) {
    findOneOrThrow(
      await this.drizzle.db.select().from(chatRoom).where(eq(chatRoom.id, roomId)),
      new ChatRoomNotFoundError(roomId),
    );

    const safeContent = gateContent(content);
    const displayName = await this.resolveDisplayName(userId, username);
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        roomId,
        userId,
        username: displayName,
        content: safeContent,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record.id,
      roomId,
      userId,
    });

    const message = toMessage(record);
    void this.transport.publish(chatChannel(roomId), message);
    return message;
  }

  async deleteMessage(id: ChatMessage['id'], userId: User['id']) {
    const message = findOneOrThrow(
      await this.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id)),
      new ChatMessageNotFoundError(id),
    );
    assertOwnership(message.userId, userId, new ChatMessageOwnershipError(id));

    await this.drizzle.db
      .update(chatMessage)
      .set({ isDeleted: true })
      .where(eq(chatMessage.id, id));

    return { success: true } as const;
  }

  async getGlobalMessages(limit = 50, viewerId?: User['id']) {
    const conditions = [isNull(chatMessage.roomId), eq(chatMessage.isDeleted, false)];
    await this.appendBlockFilter(conditions, viewerId);
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toMessage);
  }

  async sendGlobalMessage(userId: User['id'], username: string, content: string) {
    const safeContent = gateContent(content);
    const displayName = await this.resolveDisplayName(userId, username);
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        roomId: null,
        userId,
        username: displayName,
        content: safeContent,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record.id,
      roomId: null,
      userId,
    });

    const message = toMessage(record);
    void this.transport.publish(chatChannel(null), message);
    return message;
  }

  async listBlockedUsers(blockerId: User['id']) {
    const rows = await this.drizzle.db
      .select({ blockedId: chatUserBlock.blockedId, createdAt: chatUserBlock.createdAt })
      .from(chatUserBlock)
      .where(eq(chatUserBlock.blockerId, blockerId))
      .orderBy(desc(chatUserBlock.createdAt));
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }));
  }

  async blockUser(blockerId: User['id'], blockedId: User['id']) {
    if (blockerId === blockedId) throw new ChatSelfBlockError();

    // Idempotent: re-blocking is a no-op, so only the first block emits an event.
    const inserted = await this.drizzle.db
      .insert(chatUserBlock)
      .values({ blockerId, blockedId })
      .onConflictDoNothing({ target: [chatUserBlock.blockerId, chatUserBlock.blockedId] })
      .returning();

    if (inserted.length > 0) this.events.emit('chat.user.blocked', { blockerId, blockedId });
    return { success: true } as const;
  }

  async unblockUser(blockerId: User['id'], blockedId: User['id']) {
    const removed = await this.drizzle.db
      .delete(chatUserBlock)
      .where(and(eq(chatUserBlock.blockerId, blockerId), eq(chatUserBlock.blockedId, blockedId)))
      .returning();

    if (removed.length > 0) this.events.emit('chat.user.unblocked', { blockerId, blockedId });
    return { success: true } as const;
  }
}
