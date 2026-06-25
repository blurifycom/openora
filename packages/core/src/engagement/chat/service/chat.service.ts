import { type EventBus, createDomainError, assertOwnership } from '@blurifycom/core/server';
import type { RealtimeTransport } from '@blurifycom/core/contracts';
import { DrizzleService, findOneOrThrow } from '@blurifycom/core/server';
import { eq, and, isNull, lt, desc, asc, notInArray } from 'drizzle-orm';
// Sanctioned read-only cross-module table read (display name lives in identity).
// The username shown on a message is resolved server-side from the verified user,
// never from a client-supplied header - so it cannot be spoofed.
import { user } from '@blurifycom/core/pam/schema/identity';
import type { User } from '@blurifycom/core/pam/schema/identity';
import { chatRoom, chatMessage, chatUserBlock } from '../schema/index.js';
import type { ChatRoom, ChatMessage, BlockedUser } from '../schemas/index.js';
import { moderateContent } from '../moderation/index.js';

/** Single source for channel names so publishers and subscribers always align. */
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

// Surfaced to the sender (mapped to BAD_REQUEST) so they learn the message was
// withheld and never delivered to other players (ABC-45 AC8/AC9).
export const ChatMessageBlockedError = createDomainError(
  'ChatMessageBlockedError',
  () => 'Message blocked: it contains prohibited language',
);

export const ChatSelfBlockError = createDomainError(
  'ChatSelfBlockError',
  () => 'You cannot block yourself',
);

/** Rejects profane content (never delivered) and returns URL-sanitized text safe to persist. */
function gateContent(content: string): string {
  const result = moderateContent(content);
  if (!result.ok) throw new ChatMessageBlockedError();
  return result.content;
}

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

  /**
   * Live feed for `viewerId`. Messages from users the viewer has blocked are
   * dropped client-bound only - the sender and everyone else still receive them
   * (ABC-45 AC11). The block set is loaded once at subscribe time.
   */
  subscribeMessages(
    roomId: ChatRoom['id'] | null,
    listener: (message: ChatMessage) => void,
    viewerId?: User['id'],
  ) {
    // `null` until the block set loads. Messages arriving before then are buffered
    // (not dropped, not leaked) and flushed once it resolves - closes the window
    // where a blocked sender's message could slip through. Muting is best-effort
    // UX, so a load failure fails open (empty set) rather than freezing the feed.
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

  async getRoomMessages(
    roomId: ChatRoom['id'],
    limit = 50,
    before?: string,
    viewerId?: User['id'],
  ) {
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

  async sendRoomMessage(
    userId: User['id'],
    username: string,
    roomId: ChatRoom['id'],
    content: string,
  ) {
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
      messageId: record!.id,
      roomId,
      userId,
    });

    const message = toMessage(record!);
    // Best-effort push after commit; DB is the system of record for backfill.
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
      messageId: record!.id,
      roomId: null,
      userId,
    });

    const message = toMessage(record!);
    void this.transport.publish(chatChannel(null), message);
    return message;
  }

  async listBlockedUsers(blockerId: User['id']): Promise<BlockedUser[]> {
    const rows = await this.drizzle.db
      .select({ blockedId: chatUserBlock.blockedId, createdAt: chatUserBlock.createdAt })
      .from(chatUserBlock)
      .where(eq(chatUserBlock.blockerId, blockerId))
      .orderBy(desc(chatUserBlock.createdAt));
    return rows.map((r) => ({ blockedId: r.blockedId, createdAt: r.createdAt.toISOString() }));
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
