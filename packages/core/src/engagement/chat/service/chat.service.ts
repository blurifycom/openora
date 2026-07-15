import { randomInt } from 'node:crypto';
import {
  type EventBus,
  createDomainError,
  assertOwnership,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
} from '@openora/core/server';
import type { RealtimeTransport } from '@openora/core/contracts';
import { eq, and, isNull, lt, desc, asc, notInArray, inArray } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import type { User } from '@openora/core/pam/schema/identity';
import {
  chatRoom,
  chatMessage,
  chatUserBlock,
  chatRoomMember,
  chatRoomBan,
} from '../schema/index.js';
import type { ChatRoom, ChatMessage } from '../contract/index.js';
import {
  DEFAULT_MESSAGE_LIMIT,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  PRIVATE_ROOM_SLUG_PREFIX,
} from '../contract/constants.js';
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

export const ChatRoomSlugConflictError = createDomainError(
  'ChatRoomSlugConflictError',
  (slug: string) => `A room with slug '${slug}' already exists`,
);

export const ChatRoomJoinCodeNotFoundError = createDomainError(
  'ChatRoomJoinCodeNotFoundError',
  (code: string) => `No room found with join code: ${code}`,
);

export const ChatRoomBannedError = createDomainError(
  'ChatRoomBannedError',
  (roomId: ChatRoom['id']) => `You are banned from room: ${roomId}`,
);

export const ChatRoomNotMemberError = createDomainError(
  'ChatRoomNotMemberError',
  (roomId: ChatRoom['id']) => `You are not a member of room: ${roomId}`,
);

export const ChatRoomNotModeratorError = createDomainError(
  'ChatRoomNotModeratorError',
  (roomId: ChatRoom['id']) => `You are not a moderator of room: ${roomId}`,
);

export const ChatRoomSelfModerationError = createDomainError(
  'ChatRoomSelfModerationError',
  () => 'You cannot kick or ban yourself',
);

function gateContent(content: string): string {
  const result = moderateContent(content);
  if (!result.ok) {
    throw new ChatMessageBlockedError();
  }
  return result.content;
}

function toRoom(record: typeof chatRoom.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

function toMessage(record: typeof chatMessage.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

function generateJoinCode(): string {
  return Array.from({ length: JOIN_CODE_LENGTH }, () => {
    const ch = JOIN_CODE_ALPHABET[randomInt(0, JOIN_CODE_ALPHABET.length)];
    return ch ?? 'A'; // unreachable: randomInt(0, N) is always < N
  }).join('');
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
      if (blocked && !blocked.has(message.userId)) {
        listener(message);
      }
    };
    if (viewerId) {
      this.blockedIdsFor(viewerId)
        .catch(() => new Set<User['id']>())
        .then((ids) => {
          blocked = ids;
          for (const message of pending) {
            deliver(message);
          }
          pending.length = 0;
        });
    }
    return this.transport.subscribe<ChatMessage>(chatChannel(roomId), (message) => {
      if (blocked === null) {
        pending.push(message);
      } else {
        deliver(message);
      }
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

  /** Throws ChatRoomNotFoundError or ChatRoomNotMemberError; returns the room on success. */
  async verifyRoomAccess(roomId: ChatRoom['id'], viewerId?: User['id']) {
    const [room] = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.id, roomId))
      .limit(1);
    if (!room) {
      throw new ChatRoomNotFoundError(roomId);
    }
    if (!room.isPublic) {
      if (!viewerId) {
        throw new ChatRoomNotMemberError(roomId);
      }
      const [member] = await this.drizzle.db
        .select({ id: chatRoomMember.id })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, viewerId)))
        .limit(1);
      if (!member) {
        throw new ChatRoomNotMemberError(roomId);
      }
    }
    return room;
  }

  async listRooms(viewerId?: User['id']) {
    const publicRooms = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.isPublic, true))
      .orderBy(asc(chatRoom.createdAt));

    if (!viewerId) {
      return publicRooms.map(toRoom);
    }

    const memberIds = await this.drizzle.db
      .select({ roomId: chatRoomMember.roomId })
      .from(chatRoomMember)
      .where(eq(chatRoomMember.userId, viewerId));

    if (memberIds.length === 0) {
      return publicRooms.map(toRoom);
    }

    const privateRooms = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(
        and(
          eq(chatRoom.isPublic, false),
          inArray(
            chatRoom.id,
            memberIds.map((r) => r.roomId),
          ),
        ),
      )
      .orderBy(asc(chatRoom.createdAt));

    return [...publicRooms, ...privateRooms].map(toRoom);
  }

  async getRoom({ roomId, viewerId }: { roomId: ChatRoom['id']; viewerId?: User['id'] }) {
    const room = await this.verifyRoomAccess(roomId, viewerId);
    return toRoom(room);
  }

  async getRoomMessages({
    roomId,
    limit = DEFAULT_MESSAGE_LIMIT,
    before,
    viewerId,
  }: {
    roomId: ChatRoom['id'];
    limit?: number;
    before?: string;
    viewerId?: User['id'];
  }) {
    await this.verifyRoomAccess(roomId, viewerId);

    const conditions = [eq(chatMessage.roomId, roomId), eq(chatMessage.isDeleted, false)];
    if (before) {
      conditions.push(lt(chatMessage.createdAt, new Date(before)));
    }
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
    if (!viewerId) {
      return;
    }
    const blocked = await this.blockedIdsFor(viewerId);
    if (blocked.size > 0) {
      conditions.push(notInArray(chatMessage.userId, [...blocked]));
    }
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
    await this.verifyRoomAccess(roomId, userId);

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

  async getGlobalMessages(limit = DEFAULT_MESSAGE_LIMIT, viewerId?: User['id']) {
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
    if (blockerId === blockedId) {
      throw new ChatSelfBlockError();
    }

    // Idempotent: re-blocking is a no-op, so only the first block emits an event.
    const inserted = await this.drizzle.db
      .insert(chatUserBlock)
      .values({ blockerId, blockedId })
      .onConflictDoNothing({ target: [chatUserBlock.blockerId, chatUserBlock.blockedId] })
      .returning();

    if (inserted.length > 0) {
      this.events.emit('chat.user.blocked', { blockerId, blockedId });
    }
    return { success: true } as const;
  }

  async unblockUser(blockerId: User['id'], blockedId: User['id']) {
    const removed = await this.drizzle.db
      .delete(chatUserBlock)
      .where(and(eq(chatUserBlock.blockerId, blockerId), eq(chatUserBlock.blockedId, blockedId)))
      .returning();

    if (removed.length > 0) {
      this.events.emit('chat.user.unblocked', { blockerId, blockedId });
    }
    return { success: true } as const;
  }

  async createRoom({ name, slug }: { name: string; slug: string }) {
    const [existing] = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(eq(chatRoom.slug, slug))
      .limit(1);
    if (existing) {
      throw new ChatRoomSlugConflictError(slug);
    }
    const [record] = await this.drizzle.db.insert(chatRoom).values({ name, slug }).returning();
    return toRoom(record);
  }

  async deleteRoom(id: ChatRoom['id']) {
    await this.drizzle.db.transaction(async (t) => {
      await t.delete(chatMessage).where(eq(chatMessage.roomId, id));
      findOneOrThrow(
        await t.delete(chatRoom).where(eq(chatRoom.id, id)).returning({ id: chatRoom.id }),
        new ChatRoomNotFoundError(id),
      );
    });
    return { success: true } as const;
  }

  async createPrivateRoom({ userId, name }: { userId: User['id']; name: string }) {
    const joinCode = generateJoinCode();
    const slug = `${PRIVATE_ROOM_SLUG_PREFIX}${joinCode.toLowerCase()}`;
    const [record] = await this.drizzle.db
      .insert(chatRoom)
      .values({ name, slug, isPublic: false, joinCode, creatorId: userId })
      .returning();
    await this.drizzle.db
      .insert(chatRoomMember)
      .values({ roomId: record.id, userId, role: 'moderator' })
      .onConflictDoNothing();
    this.events.emit('chat.private_room.created', { roomId: record.id, creatorId: userId });
    return toRoom(record);
  }

  async joinRoom({ userId, joinCode }: { userId: User['id']; joinCode: string }) {
    const [room] = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(eq(chatRoom.joinCode, joinCode))
      .limit(1);
    if (!room) {
      throw new ChatRoomJoinCodeNotFoundError(joinCode);
    }
    const [ban] = await this.drizzle.db
      .select({ id: chatRoomBan.id })
      .from(chatRoomBan)
      .where(and(eq(chatRoomBan.roomId, room.id), eq(chatRoomBan.userId, userId)))
      .limit(1);
    if (ban) {
      throw new ChatRoomBannedError(room.id);
    }
    // Idempotent: re-joining is a no-op (preserves existing role).
    await this.drizzle.db
      .insert(chatRoomMember)
      .values({ roomId: room.id, userId })
      .onConflictDoNothing();
    return toRoom(room);
  }

  async leaveRoom({ userId, roomId }: { userId: User['id']; roomId: ChatRoom['id'] }) {
    await this.drizzle.db
      .delete(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
    return { success: true } as const;
  }

  async kickMember({
    moderatorId,
    roomId,
    userId,
  }: {
    moderatorId: User['id'];
    roomId: ChatRoom['id'];
    userId: User['id'];
  }) {
    if (moderatorId === userId) {
      throw new ChatRoomSelfModerationError();
    }
    const [mod] = await this.drizzle.db
      .select({ role: chatRoomMember.role })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, moderatorId)))
      .limit(1);
    if (!mod || mod.role !== 'moderator') {
      throw new ChatRoomNotModeratorError(roomId);
    }
    await this.drizzle.db
      .delete(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
    this.events.emit('chat.room.member.kicked', { roomId, userId, kickedBy: moderatorId });
    return { success: true } as const;
  }

  async banMember({
    moderatorId,
    roomId,
    userId,
  }: {
    moderatorId: User['id'];
    roomId: ChatRoom['id'];
    userId: User['id'];
  }) {
    if (moderatorId === userId) {
      throw new ChatRoomSelfModerationError();
    }
    const [mod] = await this.drizzle.db
      .select({ role: chatRoomMember.role })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, moderatorId)))
      .limit(1);
    if (!mod || mod.role !== 'moderator') {
      throw new ChatRoomNotModeratorError(roomId);
    }
    // Idempotent: banning an already-banned user is a no-op.
    await this.drizzle.db
      .insert(chatRoomBan)
      .values({ roomId, userId, bannedBy: moderatorId })
      .onConflictDoNothing();
    await this.drizzle.db
      .delete(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
    this.events.emit('chat.room.member.banned', { roomId, userId, bannedBy: moderatorId });
    return { success: true } as const;
  }

  async listRoomMembers({ roomId, viewerId }: { roomId: ChatRoom['id']; viewerId?: User['id'] }) {
    await this.verifyRoomAccess(roomId, viewerId);
    const members = await this.drizzle.db
      .select({
        userId: chatRoomMember.userId,
        role: chatRoomMember.role,
        joinedAt: chatRoomMember.joinedAt,
      })
      .from(chatRoomMember)
      .where(eq(chatRoomMember.roomId, roomId))
      .orderBy(asc(chatRoomMember.joinedAt));
    return members.map((m) => serializeRow(m, { dateFields: ['joinedAt'] }));
  }
}
