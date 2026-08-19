import { randomInt, randomUUID } from 'node:crypto';
import {
  type EventBus,
  createLogger,
  makeOwnershipError,
  makeConflictError,
  createDomainError,
  assertOwnership,
  DrizzleService,
  findOneOrThrow,
  serializeRow,
  pageToOffset,
  withAdvisoryXactLock,
  type DrizzleDb,
} from '@openora/core/server';
import type {
  ClientMeta,
  ChatModeration,
  RealtimeTransport,
  CommandMetadata,
  ChatSystemMessage,
  CommandChatMessage,
  AdminUserDirectory,
  AuditWritePort,
  FriendshipDissolvedPayload,
  IdentityReader,
  SocialCommands,
  Uuid,
} from '@openora/core/contracts';
import { chatChannel, GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import {
  eq,
  and,
  isNull,
  or,
  gt,
  lt,
  desc,
  asc,
  notInArray,
  inArray,
  count,
  ne,
  ilike,
} from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import type { User } from '@openora/core/pam/schema/identity';
import {
  chatRoom,
  chatMessage,
  chatUserBlock,
  chatUserIgnore,
  chatRoomMember,
  chatRoomBan,
  chatRoomRule,
  chatRoomConfiguration,
  chatPlatformBan,
} from '../schema/index.js';
import { ChatMessageNotFoundError, ChatRoomNotFoundError } from './chat-moderation.service.js';
export {
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
  ChatRoomLastModeratorError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomBannedError,
  ChatPlayerBannedError,
} from './errors/chat-moderation.errors.js';
import {
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatPlayerBannedError,
} from './errors/chat-moderation.errors.js';
import type {
  AdminRoomSortBy,
  BlockedUserSortBy,
  IgnoredUserSortBy,
  ChatRoom,
  ChatMessage,
  ChatRoomCategory,
  ChatRoomRole,
  SortOrder,
} from '../contract/index.js';
import {
  DEFAULT_MESSAGE_LIMIT,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  MAX_PRIVATE_ROOMS_PER_PLAYER,
  PRIVATE_ROOM_SLUG_PREFIX,
} from '../contract/constants.js';
import { moderateContent } from '../moderation/index.js';
const logger = createLogger('chat');

function publishChatEvent<T>(transport: RealtimeTransport, roomId: string | null, event: T): void {
  void Promise.resolve()
    .then(() => transport.publish(chatChannel(roomId), event))
    .catch((err: unknown) => {
      logger.error({ err, roomId }, 'chat realtime publish failed');
    });
}

export const ChatRoomOwnershipError = makeOwnershipError('ChatRoom');

export const ChatMessageBlockedError = createDomainError(
  'ChatMessageBlockedError',
  () => 'Message blocked: it contains prohibited language',
);

export const ChatSelfBlockError = createDomainError(
  'ChatSelfBlockError',
  () => 'You cannot block yourself',
);

export const ChatSelfIgnoreError = createDomainError(
  'ChatSelfIgnoreError',
  () => 'You cannot ignore yourself',
);

export const ChatRoomSlugConflictError = makeConflictError(
  'ChatRoomSlugConflictError',
  'A room with this slug already exists',
);

export const ChatRoomLimitReachedError = makeConflictError(
  'ChatRoomLimitReachedError',
  'Private room limit reached',
);

export const ChatRoomRuleNotFoundError = createDomainError(
  'ChatRoomRuleNotFoundError',
  (id: string) => `Chat room rule not found: ${id}`,
);
export const ChatRoomConfigurationNotFoundError = createDomainError(
  'ChatRoomConfigurationNotFoundError',
  (id: string) => `Chat room configuration not found: ${id}`,
);

const CHAT_MODERATOR_ROLES: readonly ChatRoomRole[] = ['moderator', 'owner'];

function gateContent(content: string): string {
  const result = moderateContent(content);
  if (!result.ok) {
    throw new ChatMessageBlockedError();
  }
  return result.content;
}

function toRoom(record: typeof chatRoom.$inferSelect) {
  const { deletedAt: _deletedAt, ...room } = record;
  return serializeRow(
    { ...room, isBanned: false, bannedUntil: null },
    { dateFields: ['createdAt', 'bannedUntil'] },
  );
}

function toMessage(record: typeof chatMessage.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

function toRule(record: typeof chatRoomRule.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });
}

function toConfiguration(record: typeof chatRoomConfiguration.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt', 'updatedAt'] });
}

function toSystemMessage(record: typeof chatMessage.$inferSelect): ChatSystemMessage {
  const message = toMessage(record);
  return { ...message, actorId: message.userId } as ChatSystemMessage;
}

function toPublicMessage(record: typeof chatMessage.$inferSelect): ChatMessage {
  if (record.type === 'system') {
    return toSystemMessage(record);
  }
  return toMessage(record) as ChatMessage;
}

const BLOCKED_USER_SORT_COLUMNS = { createdAt: chatUserBlock.createdAt } as const satisfies Record<
  BlockedUserSortBy,
  unknown
>;

const IGNORED_USER_SORT_COLUMNS = {
  createdAt: chatUserIgnore.createdAt,
} as const satisfies Record<IgnoredUserSortBy, unknown>;

function generateJoinCode(): string {
  return Array.from({ length: JOIN_CODE_LENGTH }, () => {
    const ch = JOIN_CODE_ALPHABET[randomInt(0, JOIN_CODE_ALPHABET.length)];
    return ch ?? 'A';
  }).join('');
}

function generatePrivateRoomSlug(joinCode: string): string {
  const normalizedJoinCode = joinCode.toLowerCase();
  let slug = `${PRIVATE_ROOM_SLUG_PREFIX}${randomUUID()}`;
  while (slug.includes(normalizedJoinCode)) {
    slug = `${PRIVATE_ROOM_SLUG_PREFIX}${randomUUID()}`;
  }
  return slug;
}

function isUniqueConstraintViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) {
    return false;
  }
  return e.code === '23505';
}

export class ChatService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly transport: RealtimeTransport,
    private readonly directory: AdminUserDirectory,
    private readonly audit: AuditWritePort,
    private readonly moderation: ChatModeration,
    private readonly identityReader: IdentityReader,
    private readonly socialCommands?: SocialCommands,
  ) {}

  subscribeMessages(
    roomId: ChatRoom['id'] | null,
    listener: (message: ChatMessage) => void,
    viewerId?: User['id'],
    connectionId: string = randomUUID(),
  ) {
    const channel = chatChannel(roomId);
    const presenceMemberId = viewerId ?? `anonymous:${connectionId}`;
    const presence = this.transport.presence;
    presence?.join(channel, presenceMemberId, connectionId);
    let blocked: ReadonlySet<User['id']> | null = viewerId ? null : new Set();
    const pending: ChatMessage[] = [];
    const deliver = (message: ChatMessage) => {
      if (blocked && !blocked.has(message.userId)) {
        listener(message);
      }
    };
    if (viewerId) {
      this.excludedSenderIdsFor(viewerId)
        .catch(() => new Set<User['id']>())
        .then((ids) => {
          blocked = ids;
          for (const message of pending) {
            deliver(message);
          }
          pending.length = 0;
        });
    }
    const unsubscribe = this.transport.subscribe<ChatMessage>(
      channel,
      (message) => {
        if (blocked === null) {
          pending.push(message);
        } else {
          deliver(message);
        }
      },
      viewerId,
    );
    return () => {
      unsubscribe();
      presence?.leave(channel, presenceMemberId, connectionId);
    };
  }

  async getOnlineCount(roomId: ChatRoom['id'] | null) {
    const count = await this.transport.presence?.count(chatChannel(roomId));
    return { count: count ?? 0 };
  }

  private async blockedIdsFor(viewerId: User['id']) {
    const rows = await this.drizzle.db
      .select({ blockedId: chatUserBlock.blockedId })
      .from(chatUserBlock)
      .where(and(eq(chatUserBlock.blockerId, viewerId), isNull(chatUserBlock.removedAt)));
    return new Set(rows.map((r) => r.blockedId));
  }

  private async ignoredIdsFor(viewerId: User['id']) {
    const rows = await this.drizzle.db
      .select({ ignoredId: chatUserIgnore.ignoredId })
      .from(chatUserIgnore)
      .where(and(eq(chatUserIgnore.ignorerId, viewerId), isNull(chatUserIgnore.removedAt)));
    return new Set(rows.map((r) => r.ignoredId));
  }

  private async excludedSenderIdsFor(viewerId: User['id']) {
    const [blocked, ignored] = await Promise.all([
      this.blockedIdsFor(viewerId),
      this.ignoredIdsFor(viewerId),
    ]);
    return new Set([...blocked, ...ignored]);
  }

  private async usernamesFor(userIds: readonly User['id'][]) {
    const summaries = await this.directory.lookupPlayers(userIds);
    return new Map(summaries.map((s) => [s.userId, s.username]));
  }

  private async resolveDisplayName(userId: User['id'], fallback: string) {
    const [row] = await this.drizzle.db
      .select({ name: user.name, username: user.username })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.username?.trim() || row?.name?.trim() || fallback || 'anonymous';
  }

  /** Throws ChatRoomNotFoundError or ChatRoomNotMemberError; returns the room on success. */
  async verifyRoomAccess(roomId: ChatRoom['id'], viewerId?: User['id']) {
    const [room] = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(and(eq(chatRoom.id, roomId), isNull(chatRoom.deletedAt)))
      .limit(1);
    if (!room) {
      throw new ChatRoomNotFoundError(roomId);
    }
    if (viewerId) {
      const now = new Date();
      const [roomBan] = await this.drizzle.db
        .select({ expiresAt: chatRoomBan.expiresAt })
        .from(chatRoomBan)
        .where(
          and(
            eq(chatRoomBan.roomId, roomId),
            eq(chatRoomBan.userId, viewerId),
            isNull(chatRoomBan.liftedAt),
            or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, now)),
          ),
        )
        .limit(1);
      if (roomBan) {
        throw new ChatPlayerBannedError(roomBan.expiresAt);
      }
      const [platformBan] = await this.drizzle.db
        .select({ expiresAt: chatPlatformBan.expiresAt })
        .from(chatPlatformBan)
        .where(
          and(
            eq(chatPlatformBan.userId, viewerId),
            isNull(chatPlatformBan.liftedAt),
            or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, now)),
            room.isPublic
              ? or(
                  eq(chatPlatformBan.scope, '__all'),
                  eq(chatPlatformBan.scope, '__all_public'),
                  and(eq(chatPlatformBan.scope, 'room'), eq(chatPlatformBan.roomId, roomId)),
                )
              : or(
                  eq(chatPlatformBan.scope, '__all'),
                  and(eq(chatPlatformBan.scope, 'room'), eq(chatPlatformBan.roomId, roomId)),
                ),
          ),
        )
        .limit(1);
      if (platformBan) {
        throw new ChatPlayerBannedError(platformBan.expiresAt);
      }
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

  async verifyGlobalAccess(viewerId?: User['id']) {
    if (!viewerId) {
      return;
    }
    const [platformBan] = await this.drizzle.db
      .select({ expiresAt: chatPlatformBan.expiresAt })
      .from(chatPlatformBan)
      .where(
        and(
          eq(chatPlatformBan.userId, viewerId),
          isNull(chatPlatformBan.liftedAt),
          or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, new Date())),
          or(
            eq(chatPlatformBan.scope, '__global'),
            eq(chatPlatformBan.scope, '__all_public'),
            eq(chatPlatformBan.scope, '__all'),
          ),
        ),
      )
      .limit(1);
    if (platformBan) {
      throw new ChatPlayerBannedError(platformBan.expiresAt);
    }
  }

  async listRooms(viewerId?: User['id']) {
    const publicRooms = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(and(eq(chatRoom.isPublic, true), isNull(chatRoom.deletedAt)))
      .orderBy(asc(chatRoom.createdAt));

    if (!viewerId) {
      return publicRooms.map(toRoom);
    }

    const memberIds = await this.drizzle.db
      .select({ roomId: chatRoomMember.roomId })
      .from(chatRoomMember)
      .where(eq(chatRoomMember.userId, viewerId));

    const now = new Date();
    const bans = await this.drizzle.db
      .select({ roomId: chatRoomBan.roomId, expiresAt: chatRoomBan.expiresAt })
      .from(chatRoomBan)
      .where(
        and(
          eq(chatRoomBan.userId, viewerId),
          isNull(chatRoomBan.liftedAt),
          or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, now)),
        ),
      );
    const roomBanById = new Map(bans.map((ban) => [ban.roomId, ban.expiresAt]));
    const bannedPrivateIds = bans.map((ban) => ban.roomId);
    const platformBans = await this.drizzle.db
      .select({
        scope: chatPlatformBan.scope,
        roomId: chatPlatformBan.roomId,
        expiresAt: chatPlatformBan.expiresAt,
      })
      .from(chatPlatformBan)
      .where(
        and(
          eq(chatPlatformBan.userId, viewerId),
          isNull(chatPlatformBan.liftedAt),
          or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, now)),
        ),
      );
    const allPublicBan = platformBans.find(
      (ban) => ban.scope === '__all_public' || ban.scope === '__all',
    );
    const allPrivateBan = platformBans.find((ban) => ban.scope === '__all');
    const globalBan = platformBans.find((ban) => ban.scope === '__global');
    for (const ban of platformBans) {
      if (ban.scope === 'room' && ban.roomId) {
        roomBanById.set(ban.roomId, ban.expiresAt);
      }
    }

    const privateRooms = await this.drizzle.db
      .select()
      .from(chatRoom)
      .where(
        and(
          eq(chatRoom.isPublic, false),
          isNull(chatRoom.deletedAt),
          inArray(
            chatRoom.id,
            memberIds.map((r) => r.roomId),
          ),
        ),
      )
      .orderBy(asc(chatRoom.createdAt));

    const privateBannedRooms = bannedPrivateIds.length
      ? await this.drizzle.db
          .select()
          .from(chatRoom)
          .where(
            and(
              eq(chatRoom.isPublic, false),
              isNull(chatRoom.deletedAt),
              inArray(chatRoom.id, bannedPrivateIds),
            ),
          )
      : [];
    const uniqueRooms = [...publicRooms, ...privateRooms, ...privateBannedRooms].filter(
      (room, index, rows) => rows.findIndex((candidate) => candidate.id === room.id) === index,
    );
    return uniqueRooms.map((room) => {
      const roomBanUntil = roomBanById.get(room.id) ?? null;
      const platformBanUntil = room.isPublic
        ? (allPublicBan?.expiresAt ?? null)
        : (allPrivateBan?.expiresAt ?? null);
      return serializeRow(
        {
          ...room,
          isBanned:
            room.slug === GLOBAL_CHAT_ROOM_ID
              ? Boolean(globalBan || allPublicBan)
              : roomBanById.has(room.id) || Boolean(room.isPublic ? allPublicBan : allPrivateBan),
          bannedUntil: roomBanById.has(room.id) ? roomBanUntil : platformBanUntil,
        },
        { dateFields: ['createdAt', 'bannedUntil'] },
      );
    });
  }

  async listAdminRooms({
    page,
    limit,
    name,
    sortBy,
    sortOrder,
  }: {
    page: number;
    limit: number;
    name?: string;
    sortBy: AdminRoomSortBy;
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = sortBy === 'name' ? chatRoom.name : chatRoom.createdAt;
    const where = and(
      eq(chatRoom.isPublic, true),
      isNull(chatRoom.deletedAt),
      name ? ilike(chatRoom.name, `%${name}%`) : undefined,
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select()
        .from(chatRoom)
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(chatRoom).where(where),
    ]);
    return { items: rows.map(toRoom), total: Number(n), page, limit };
  }

  async listModeratedRooms({
    viewerId,
    page,
    limit,
    name,
    sortBy,
    sortOrder,
  }: {
    viewerId: User['id'];
    page: number;
    limit: number;
    name?: string;
    sortBy: 'name' | 'createdAt';
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = sortBy === 'name' ? chatRoom.name : chatRoom.createdAt;
    const where = and(
      eq(chatRoomMember.userId, viewerId),
      inArray(chatRoomMember.role, ['owner', 'moderator']),
      isNull(chatRoom.deletedAt),
      name ? ilike(chatRoom.name, `%${name}%`) : undefined,
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({ room: chatRoom })
        .from(chatRoomMember)
        .innerJoin(chatRoom, eq(chatRoom.id, chatRoomMember.roomId))
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db
        .select({ n: count() })
        .from(chatRoomMember)
        .innerJoin(chatRoom, eq(chatRoom.id, chatRoomMember.roomId))
        .where(where),
    ]);
    return { items: rows.map(({ room }) => toRoom(room)), total: Number(n), page, limit };
  }

  async getRoom({ roomId, viewerId }: { roomId: ChatRoom['id']; viewerId?: User['id'] }) {
    const room = await this.verifyRoomAccess(roomId, viewerId);
    return toRoom(room);
  }

  private async assertRoomModerator(
    roomId: ChatRoom['id'],
    actorId: User['id'],
    targetId?: User['id'],
  ) {
    const [actor] = await this.drizzle.db
      .select({ role: chatRoomMember.role })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, actorId)))
      .limit(1);
    if (!actor || !CHAT_MODERATOR_ROLES.includes(actor.role)) {
      throw new ChatRoomNotModeratorError(roomId);
    }
    if (targetId) {
      const [target] = await this.drizzle.db
        .select({ role: chatRoomMember.role })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, targetId)))
        .limit(1);
      if (actor.role !== 'owner' && target && target.role !== 'member') {
        throw new ChatRoomNotModeratorError(roomId);
      }
    }
    return actor.role;
  }

  async listRoomRules(
    roomReference: ChatRoom['id'] | typeof GLOBAL_CHAT_ROOM_ID,
    viewerId?: User['id'],
  ) {
    const isGlobalRoom = roomReference === GLOBAL_CHAT_ROOM_ID;
    const [room] = await this.drizzle.db
      .select({ id: chatRoom.id, slug: chatRoom.slug, isPublic: chatRoom.isPublic })
      .from(chatRoom)
      .where(
        and(
          isGlobalRoom ? eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID) : eq(chatRoom.id, roomReference),
          isNull(chatRoom.deletedAt),
        ),
      )
      .limit(1);
    if (!room) {
      throw new ChatRoomNotFoundError(roomReference);
    }
    if (!room.isPublic) {
      if (!viewerId) {
        throw new ChatRoomNotMemberError(room.id);
      }
      const [member] = await this.drizzle.db
        .select({ id: chatRoomMember.id })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, room.id), eq(chatRoomMember.userId, viewerId)))
        .limit(1);
      if (!member) {
        throw new ChatRoomNotMemberError(room.id);
      }
    }
    const rows = await this.drizzle.db
      .select()
      .from(chatRoomRule)
      .where(eq(chatRoomRule.roomId, room.id))
      .orderBy(asc(chatRoomRule.orderNum), asc(chatRoomRule.createdAt));
    return rows.map(toRule);
  }

  async createRoomRule({
    roomId,
    actorId,
    orderNum,
    content,
  }: {
    roomId: ChatRoom['id'];
    actorId: User['id'];
    orderNum?: number;
    content: string;
  }) {
    await this.assertRoomModerator(roomId, actorId);
    let nextOrder = orderNum;
    if (nextOrder === undefined) {
      const [last] = await this.drizzle.db
        .select({ orderNum: chatRoomRule.orderNum })
        .from(chatRoomRule)
        .where(eq(chatRoomRule.roomId, roomId))
        .orderBy(desc(chatRoomRule.orderNum))
        .limit(1);
      nextOrder = (last?.orderNum ?? 0) + 1;
    }
    const [created] = await this.drizzle.db
      .insert(chatRoomRule)
      .values({ roomId, createdBy: actorId, orderNum: nextOrder, content })
      .returning();
    return toRule(created);
  }

  async updateRoomRule({
    roomId,
    id,
    actorId,
    orderNum,
    content,
  }: {
    roomId: ChatRoom['id'];
    id: string;
    actorId: User['id'];
    orderNum?: number;
    content?: string;
  }) {
    await this.assertRoomModerator(roomId, actorId);
    const patch: Partial<typeof chatRoomRule.$inferInsert> = { updatedAt: new Date() };
    if (orderNum !== undefined) {
      patch.orderNum = orderNum;
    }
    if (content !== undefined) {
      patch.content = content;
    }
    const updated = findOneOrThrow(
      await this.drizzle.db
        .update(chatRoomRule)
        .set(patch)
        .where(and(eq(chatRoomRule.id, id), eq(chatRoomRule.roomId, roomId)))
        .returning(),
      new ChatRoomRuleNotFoundError(id),
    );
    return toRule(updated);
  }

  async deleteRoomRule({
    roomId,
    id,
    actorId,
  }: {
    roomId: ChatRoom['id'];
    id: string;
    actorId: User['id'];
  }) {
    await this.assertRoomModerator(roomId, actorId);
    findOneOrThrow(
      await this.drizzle.db
        .delete(chatRoomRule)
        .where(and(eq(chatRoomRule.id, id), eq(chatRoomRule.roomId, roomId)))
        .returning({ id: chatRoomRule.id }),
      new ChatRoomRuleNotFoundError(id),
    );
    return { success: true } as const;
  }

  async getRoomConfiguration(roomId: ChatRoom['id'], viewerId?: User['id']) {
    await this.verifyRoomAccess(roomId, viewerId);
    let [config] = await this.drizzle.db
      .select()
      .from(chatRoomConfiguration)
      .where(eq(chatRoomConfiguration.roomId, roomId))
      .limit(1);
    if (!config) {
      [config] = await this.drizzle.db.insert(chatRoomConfiguration).values({ roomId }).returning();
    }
    return toConfiguration(config);
  }

  async updateRoomConfiguration({
    roomId,
    actorId,
    ...patch
  }: {
    roomId: ChatRoom['id'];
    actorId: User['id'];
    slowMode?: boolean;
    slowModeSeconds?: number;
    readOnlyMode?: boolean;
    onlyInvitedCanJoin?: boolean;
    lockRoom?: boolean;
    moderatorInvite?: boolean;
  }) {
    await this.assertRoomModerator(roomId, actorId);
    const [config] = await this.drizzle.db
      .insert(chatRoomConfiguration)
      .values({ roomId, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: chatRoomConfiguration.roomId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return toConfiguration(config);
  }

  async listRoomUsers({
    roomId,
    actorId,
    status,
  }: {
    roomId: ChatRoom['id'];
    actorId: User['id'];
    status: 'all' | 'member' | 'owner';
  }) {
    await this.assertRoomModerator(roomId, actorId);
    const role = status === 'all' ? undefined : status;
    const canSeeAdminUsers = await this.canSeeAdminUsers(actorId);
    const members = await this.drizzle.db
      .select({ member: chatRoomMember, username: user.name })
      .from(chatRoomMember)
      .leftJoin(user, eq(user.id, chatRoomMember.userId))
      .where(
        and(
          eq(chatRoomMember.roomId, roomId),
          role ? eq(chatRoomMember.role, role) : undefined,
          canSeeAdminUsers
            ? undefined
            : or(isNull(user.id), notInArray(user.role, ['admin', 'super-admin'])),
        ),
      )
      .orderBy(asc(chatRoomMember.joinedAt));
    const bans = await this.drizzle.db
      .select()
      .from(chatRoomBan)
      .where(and(eq(chatRoomBan.roomId, roomId), isNull(chatRoomBan.liftedAt)));
    const now = Date.now();
    const activeBans = new Map(
      bans
        .filter((ban) => !ban.expiresAt || ban.expiresAt.getTime() > now)
        .map((ban) => [ban.userId, ban]),
    );
    const names = await this.directory.lookupPlayers(members.map(({ member }) => member.userId));
    const nameById = new Map(names.map((name) => [name.userId, name.username]));
    return members.map(({ member, username }) => {
      const ban = activeBans.get(member.userId);
      return serializeRow(
        {
          userId: member.userId,
          username: nameById.get(member.userId) ?? username ?? null,
          role: member.role,
          joinedAt: member.joinedAt,
          blocked: Boolean(ban),
          banId: ban?.id ?? null,
          banExpiresAt: ban?.expiresAt ?? null,
        },
        { dateFields: ['joinedAt', 'banExpiresAt'] },
      );
    });
  }

  async listRoomBlockedUsers({ roomId, actorId }: { roomId: ChatRoom['id']; actorId: User['id'] }) {
    await this.assertRoomModerator(roomId, actorId);
    const rows = await this.drizzle.db
      .select()
      .from(chatRoomBan)
      .where(
        and(
          eq(chatRoomBan.roomId, roomId),
          isNull(chatRoomBan.liftedAt),
          or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(chatRoomBan.createdAt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latest.has(row.userId)) {
        latest.set(row.userId, row);
      }
    }
    return [...latest.values()].map((row) =>
      serializeRow(row, { dateFields: ['createdAt', 'expiresAt', 'liftedAt'] }),
    );
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

    const conditions = [
      eq(chatMessage.roomId, roomId),
      eq(chatMessage.isDeleted, false),
      isNull(chatMessage.deletedAt),
    ];
    if (before) {
      conditions.push(lt(chatMessage.createdAt, new Date(before)));
    }
    await this.appendExcludedSendersFilter(conditions, viewerId);
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toPublicMessage);
  }

  async listAdminRoomMessages({
    roomId,
    page,
    limit,
    senderId,
    playerId,
    includeDeleted,
  }: {
    roomId: ChatRoom['id'] | typeof GLOBAL_CHAT_ROOM_ID;
    page: number;
    limit: number;
    senderId?: User['id'];
    playerId?: Uuid;
    includeDeleted: boolean;
  }) {
    const roomWhere =
      roomId === GLOBAL_CHAT_ROOM_ID
        ? and(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID), isNull(chatRoom.deletedAt))
        : and(eq(chatRoom.id, roomId), isNull(chatRoom.deletedAt));
    const [room] = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(roomWhere)
      .limit(1);
    if (!room) {
      throw new ChatRoomNotFoundError(roomId);
    }

    const where = and(
      roomId === GLOBAL_CHAT_ROOM_ID ? isNull(chatMessage.roomId) : eq(chatMessage.roomId, roomId),
      includeDeleted ? undefined : eq(chatMessage.isDeleted, false),
      senderId ? eq(chatMessage.userId, senderId) : undefined,
      playerId ? eq(player.id, playerId) : undefined,
    );
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({ message: chatMessage, playerId: player.id })
        .from(chatMessage)
        .leftJoin(player, eq(player.userId, chatMessage.userId))
        .where(where)
        .orderBy(desc(chatMessage.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db
        .select({ n: count() })
        .from(chatMessage)
        .leftJoin(player, eq(player.userId, chatMessage.userId))
        .where(where),
    ]);
    return {
      items: rows.map(({ message, playerId }) => ({ ...toPublicMessage(message), playerId })),
      total: Number(n),
      page,
      limit,
    };
  }

  async listAdminMessages({
    page,
    limit,
    roomId,
    senderId,
    playerId,
    search,
    includeDeleted,
    sortOrder,
  }: {
    page: number;
    limit: number;
    roomId?: ChatRoom['id'] | typeof GLOBAL_CHAT_ROOM_ID;
    senderId?: User['id'];
    playerId?: Uuid;
    search?: string;
    includeDeleted: boolean;
    sortOrder: SortOrder;
  }) {
    const roomCondition =
      roomId === GLOBAL_CHAT_ROOM_ID
        ? isNull(chatMessage.roomId)
        : roomId
          ? eq(chatMessage.roomId, roomId)
          : undefined;
    const where = and(
      eq(chatMessage.type, 'user'),
      roomCondition,
      senderId ? eq(chatMessage.userId, senderId) : undefined,
      playerId ? eq(player.id, playerId) : undefined,
      search ? ilike(chatMessage.content, `%${search}%`) : undefined,
      includeDeleted
        ? undefined
        : and(eq(chatMessage.isDeleted, false), isNull(chatMessage.deletedAt)),
    );
    const direction = sortOrder === 'asc' ? asc : desc;
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({
          id: chatMessage.id,
          createdAt: chatMessage.createdAt,
          roomId: chatMessage.roomId,
          playerId: player.id,
          roomName: chatRoom.name,
          content: chatMessage.content,
        })
        .from(chatMessage)
        .leftJoin(player, eq(player.userId, chatMessage.userId))
        .leftJoin(chatRoom, eq(chatRoom.id, chatMessage.roomId))
        .where(where)
        .orderBy(direction(chatMessage.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db
        .select({ n: count() })
        .from(chatMessage)
        .leftJoin(player, eq(player.userId, chatMessage.userId))
        .leftJoin(chatRoom, eq(chatRoom.id, chatMessage.roomId))
        .where(where),
    ]);
    return {
      items: rows.map((row) => {
        const date = row.createdAt.toISOString();
        return {
          id: row.id,
          date,
          roomId: row.roomId ?? GLOBAL_CHAT_ROOM_ID,
          playerId: row.playerId,
          roomName: row.roomName ?? 'Global',
          content: row.content,
          time: date.slice(11, 19),
        };
      }),
      total: Number(n),
      page,
      limit,
    };
  }

  private async appendExcludedSendersFilter(
    conditions: ReturnType<typeof eq>[],
    viewerId?: User['id'],
  ) {
    if (!viewerId) {
      return;
    }
    const excluded = await this.excludedSenderIdsFor(viewerId);
    if (excluded.size > 0) {
      conditions.push(notInArray(chatMessage.userId, [...excluded]));
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
    // TODO: check RG_SELF_EXCLUSION_SERVICE before send (sealed token not yet implemented)
    const room = await this.verifyRoomAccess(roomId, userId);
    await this.moderation.assertCanSend(userId, roomId, room.isPublic);

    const safeContent = gateContent(content);
    const resolvedUsername = await this.resolveDisplayName(userId, username);
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        roomId,
        userId,
        username: resolvedUsername,
        content: safeContent,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record.id,
      roomId,
      userId,
    });

    const message = toPublicMessage(record);
    publishChatEvent(this.transport, roomId, message);
    return message;
  }

  async deleteMessage(id: ChatMessage['id'], userId: User['id'], meta?: ClientMeta) {
    const message = findOneOrThrow(
      await this.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id)),
      new ChatMessageNotFoundError(id),
    );
    let roomId = message.roomId;
    if (roomId === null) {
      const [globalRoom] = await this.drizzle.db
        .select({ id: chatRoom.id })
        .from(chatRoom)
        .where(and(eq(chatRoom.slug, '__global'), isNull(chatRoom.deletedAt)))
        .limit(1);
      if (!globalRoom) {
        throw new ChatRoomNotFoundError('__global');
      }
      roomId = globalRoom.id;
    }
    await this.assertRoomModerator(roomId, userId);
    return this.moderation.deleteMessage(id, userId, meta, 'player');
  }

  async getGlobalMessages(limit = DEFAULT_MESSAGE_LIMIT, viewerId?: User['id']) {
    await this.verifyGlobalAccess(viewerId);
    const conditions = [
      isNull(chatMessage.roomId),
      eq(chatMessage.isDeleted, false),
      isNull(chatMessage.deletedAt),
    ];
    await this.appendExcludedSendersFilter(conditions, viewerId);
    const messages = await this.drizzle.db
      .select()
      .from(chatMessage)
      .where(and(...conditions))
      .orderBy(desc(chatMessage.createdAt))
      .limit(limit);
    return messages.map(toPublicMessage);
  }

  async sendGlobalMessage(userId: User['id'], username: string, content: string) {
    // TODO: check RG_SELF_EXCLUSION_SERVICE before send (sealed token not yet implemented)
    await this.moderation.assertCanSend(userId, null);
    const safeContent = gateContent(content);
    const resolvedUsername = await this.resolveDisplayName(userId, username);
    const [record] = await this.drizzle.db
      .insert(chatMessage)
      .values({
        roomId: null,
        userId,
        username: resolvedUsername,
        content: safeContent,
      })
      .returning();

    this.events.emit('chat.message.sent', {
      messageId: record.id,
      roomId: null,
      userId,
    });

    const message = toPublicMessage(record);
    publishChatEvent(this.transport, null, message);
    return message;
  }

  async listBlockedUsers({
    blockerId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    blockerId: User['id'];
    page: number;
    limit: number;
    sortBy: BlockedUserSortBy;
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = BLOCKED_USER_SORT_COLUMNS[sortBy];
    const where = and(eq(chatUserBlock.blockerId, blockerId), isNull(chatUserBlock.removedAt));
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({ blockedId: chatUserBlock.blockedId, createdAt: chatUserBlock.createdAt })
        .from(chatUserBlock)
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(chatUserBlock).where(where),
    ]);
    const usernameByUserId = await this.usernamesFor(rows.map((r) => r.blockedId));
    return {
      items: rows.map((r) =>
        serializeRow(
          { ...r, username: usernameByUserId.get(r.blockedId) ?? null },
          { dateFields: ['createdAt'] },
        ),
      ),
      total: Number(n),
      page,
      limit,
    };
  }

  /** Backoffice-only, site-wide: every active block relationship, not just the caller's. */
  async adminListBlockedUsers({
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    page: number;
    limit: number;
    sortBy: BlockedUserSortBy;
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = BLOCKED_USER_SORT_COLUMNS[sortBy];
    const where = isNull(chatUserBlock.removedAt);
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({
          blockerId: chatUserBlock.blockerId,
          blockedId: chatUserBlock.blockedId,
          createdAt: chatUserBlock.createdAt,
        })
        .from(chatUserBlock)
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(chatUserBlock).where(where),
    ]);
    return {
      items: rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] })),
      total: Number(n),
      page,
      limit,
    };
  }

  async blockUser(blockerId: User['id'], blockedId: User['id'], meta?: ClientMeta) {
    if (blockerId === blockedId) {
      throw new ChatSelfBlockError();
    }

    // Idempotent: re-blocking while already (actively) blocked is a no-op, so only
    // the first block emits an event. The pair unique index is partial (removedAt
    // IS NULL), so a block after a prior unblock conflicts with nothing and inserts
    // a fresh active row - the removed row stays as history. No explicit conflict
    // target: this table has exactly one unique constraint (the partial pair index).
    // Any active friendship dissolves on the same tx as the block insert, so a block
    // can never leave a friendship (and the blocked user) still reachable from
    // /social/friends.
    const { inserted, dissolvedFriendship } = await this.drizzle.db.transaction(async (tx) => {
      const rows = await tx
        .insert(chatUserBlock)
        .values({ blockerId, blockedId })
        .onConflictDoNothing()
        .returning();
      const dissolved: FriendshipDissolvedPayload | null =
        rows.length > 0
          ? ((await this.socialCommands?.dissolveFriendshipOnBlock(tx, blockerId, blockedId)) ??
            null)
          : null;
      return { inserted: rows, dissolvedFriendship: dissolved };
    });

    if (dissolvedFriendship) {
      this.events.emit('social.friendship.removed', dissolvedFriendship);
    }

    if (inserted.length > 0) {
      this.events.emit('chat.user.blocked', {
        blockerId,
        actorPlayerId: await this.identityReader.getPlayerIdByUserIdSafe(blockerId),
        blockedId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(blockedId),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    return { success: true } as const;
  }

  async unblockUser(blockerId: User['id'], blockedId: User['id'], meta?: ClientMeta) {
    // Soft-delete: the partial unique index guarantees at most one active (removedAt
    // IS NULL) row per pair, so this is that row, or no-op if already unblocked.
    const removed = await this.drizzle.db
      .update(chatUserBlock)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(chatUserBlock.blockerId, blockerId),
          eq(chatUserBlock.blockedId, blockedId),
          isNull(chatUserBlock.removedAt),
        ),
      )
      .returning();

    if (removed.length > 0) {
      this.events.emit('chat.user.unblocked', {
        blockerId,
        actorPlayerId: await this.identityReader.getPlayerIdByUserIdSafe(blockerId),
        blockedId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(blockedId),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    return { success: true } as const;
  }

  async listIgnoredUsers({
    ignorerId,
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    ignorerId: User['id'];
    page: number;
    limit: number;
    sortBy: IgnoredUserSortBy;
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = IGNORED_USER_SORT_COLUMNS[sortBy];
    const where = and(eq(chatUserIgnore.ignorerId, ignorerId), isNull(chatUserIgnore.removedAt));
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({ ignoredId: chatUserIgnore.ignoredId, createdAt: chatUserIgnore.createdAt })
        .from(chatUserIgnore)
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(chatUserIgnore).where(where),
    ]);
    const usernameByUserId = await this.usernamesFor(rows.map((r) => r.ignoredId));
    return {
      items: rows.map((r) =>
        serializeRow(
          { ...r, username: usernameByUserId.get(r.ignoredId) ?? null },
          { dateFields: ['createdAt'] },
        ),
      ),
      total: Number(n),
      page,
      limit,
    };
  }

  /** Backoffice-only, site-wide: every active ignore relationship, not just the caller's. */
  async adminListIgnoredUsers({
    page,
    limit,
    sortBy,
    sortOrder,
  }: {
    page: number;
    limit: number;
    sortBy: IgnoredUserSortBy;
    sortOrder: SortOrder;
  }) {
    const dir = sortOrder === 'asc' ? asc : desc;
    const col = IGNORED_USER_SORT_COLUMNS[sortBy];
    const where = isNull(chatUserIgnore.removedAt);
    const [rows, [{ n }]] = await Promise.all([
      this.drizzle.db
        .select({
          ignorerId: chatUserIgnore.ignorerId,
          ignoredId: chatUserIgnore.ignoredId,
          createdAt: chatUserIgnore.createdAt,
        })
        .from(chatUserIgnore)
        .where(where)
        .orderBy(dir(col))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(chatUserIgnore).where(where),
    ]);
    return {
      items: rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] })),
      total: Number(n),
      page,
      limit,
    };
  }

  async ignoreUser(ignorerId: User['id'], ignoredId: User['id'], meta?: ClientMeta) {
    if (ignorerId === ignoredId) {
      throw new ChatSelfIgnoreError();
    }

    // Idempotent + soft-delete-aware - see blockUser's comment, same pattern.
    const inserted = await this.drizzle.db
      .insert(chatUserIgnore)
      .values({ ignorerId, ignoredId })
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) {
      this.events.emit('chat.user.ignored', {
        ignorerId,
        actorPlayerId: await this.identityReader.getPlayerIdByUserIdSafe(ignorerId),
        ignoredId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(ignoredId),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    return { success: true } as const;
  }

  async unignoreUser(ignorerId: User['id'], ignoredId: User['id'], meta?: ClientMeta) {
    // Soft-delete - see unblockUser's comment, same pattern.
    const removed = await this.drizzle.db
      .update(chatUserIgnore)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(chatUserIgnore.ignorerId, ignorerId),
          eq(chatUserIgnore.ignoredId, ignoredId),
          isNull(chatUserIgnore.removedAt),
        ),
      )
      .returning();

    if (removed.length > 0) {
      this.events.emit('chat.user.unignored', {
        ignorerId,
        actorPlayerId: await this.identityReader.getPlayerIdByUserIdSafe(ignorerId),
        ignoredId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(ignoredId),
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    return { success: true } as const;
  }

  async getExcludedUserIds(viewerId: User['id']): Promise<string[]> {
    return [...(await this.excludedSenderIdsFor(viewerId))];
  }

  async createRoom({
    name,
    slug,
    category,
    actorId,
    ip,
    userAgent,
  }: {
    name: string;
    slug: string;
    category: ChatRoomCategory;
    actorId?: User['id'];
  } & ClientMeta) {
    let record: typeof chatRoom.$inferSelect;
    try {
      record = await this.drizzle.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: chatRoom.id })
          .from(chatRoom)
          .where(eq(chatRoom.slug, slug))
          .limit(1);
        if (existing) {
          throw new ChatRoomSlugConflictError();
        }
        const [created] = await tx
          .insert(chatRoom)
          .values({ name, slug, category, joinCode: generateJoinCode() })
          .returning();
        await tx.insert(chatRoomConfiguration).values({ roomId: created.id });
        if (actorId) {
          await tx
            .insert(chatRoomMember)
            .values({ roomId: created.id, userId: actorId, role: 'owner' });
        }
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ChatRoomSlugConflictError();
      }
      throw error;
    }
    this.events.emit('chat.room.created', {
      roomId: record.id,
      name,
      slug,
      category,
      actorId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toRoom(record);
  }

  async updateRoom({
    id,
    name,
    slug,
    category,
    actorId,
    ip,
    userAgent,
  }: {
    id: ChatRoom['id'];
    name?: string;
    slug?: string;
    category?: ChatRoomCategory;
    actorId?: User['id'];
  } & ClientMeta) {
    const existing = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(chatRoom)
        .where(and(eq(chatRoom.id, id), isNull(chatRoom.deletedAt)))
        .limit(1),
      new ChatRoomNotFoundError(id),
    );
    if (slug !== undefined) {
      const [clash] = await this.drizzle.db
        .select({ id: chatRoom.id })
        .from(chatRoom)
        .where(and(eq(chatRoom.slug, slug), ne(chatRoom.id, id)))
        .limit(1);
      if (clash) {
        throw new ChatRoomSlugConflictError();
      }
    }
    const patch: Partial<typeof chatRoom.$inferInsert> = {};
    if (name !== undefined) {
      patch.name = name;
    }
    if (slug !== undefined) {
      patch.slug = slug;
    }
    if (category !== undefined) {
      patch.category = category;
    }
    let updated: typeof chatRoom.$inferSelect;
    try {
      updated = findOneOrThrow(
        await this.drizzle.db
          .update(chatRoom)
          .set(patch)
          .where(and(eq(chatRoom.id, id), isNull(chatRoom.deletedAt)))
          .returning(),
        new ChatRoomNotFoundError(id),
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ChatRoomSlugConflictError();
      }
      throw error;
    }
    this.events.emit('chat.room.updated', {
      roomId: id,
      actorId,
      before: { name: existing.name, slug: existing.slug, category: existing.category },
      after: { name: updated.name, slug: updated.slug, category: updated.category },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return toRoom(updated);
  }

  async updatePrivateRoom({
    id,
    name,
    actorId,
    ip,
    userAgent,
  }: {
    id: ChatRoom['id'];
    name: string;
    actorId: User['id'];
  } & ClientMeta) {
    const room = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(chatRoom)
        .where(and(eq(chatRoom.id, id), eq(chatRoom.isPublic, false), isNull(chatRoom.deletedAt)))
        .limit(1),
      new ChatRoomNotFoundError(id),
    );
    if (!room.creatorId) {
      throw new ChatRoomOwnershipError();
    }
    assertOwnership(room.creatorId, actorId, new ChatRoomOwnershipError());
    return this.updateRoom({ id, name, actorId, ip, userAgent });
  }

  async deletePrivateRoom({
    roomId,
    userId,
    ip,
    userAgent,
  }: {
    roomId: ChatRoom['id'];
    userId: User['id'];
  } & ClientMeta) {
    const room = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(chatRoom)
        .where(
          and(eq(chatRoom.id, roomId), eq(chatRoom.isPublic, false), isNull(chatRoom.deletedAt)),
        )
        .limit(1),
      new ChatRoomNotFoundError(roomId),
    );
    if (!room.creatorId) {
      throw new ChatRoomOwnershipError();
    }
    assertOwnership(room.creatorId, userId, new ChatRoomOwnershipError());
    const deletedAt = new Date();
    await this.drizzle.db.update(chatRoom).set({ deletedAt }).where(eq(chatRoom.id, roomId));
    this.events.emit('chat.private_room.deleted', {
      roomId,
      creatorId: userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      before: { name: room.name, slug: room.slug, category: room.category },
      after: { deletedAt: deletedAt.toISOString() },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }

  async deleteRoom(id: ChatRoom['id'], actorId?: User['id'], meta?: ClientMeta) {
    const deleted = findOneOrThrow(
      await this.drizzle.db
        .update(chatRoom)
        .set({ deletedAt: new Date() })
        .where(and(eq(chatRoom.id, id), isNull(chatRoom.deletedAt)))
        .returning({
          id: chatRoom.id,
          name: chatRoom.name,
          slug: chatRoom.slug,
          category: chatRoom.category,
        }),
      new ChatRoomNotFoundError(id),
    );
    this.events.emit('chat.room.deleted', {
      roomId: id,
      actorId,
      before: { name: deleted.name, slug: deleted.slug, category: deleted.category },
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true } as const;
  }

  async createPrivateRoom({
    userId,
    name,
    ip,
    userAgent,
  }: {
    userId: User['id'];
    name: string;
  } & ClientMeta) {
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(userId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const joinCode = generateJoinCode();
      const slug = generatePrivateRoomSlug(joinCode);
      try {
        const record = await this.drizzle.db.transaction((t) =>
          withAdvisoryXactLock(t, userId, async () => {
            const [{ total }] = await t
              .select({ total: count() })
              .from(chatRoom)
              .where(
                and(
                  eq(chatRoom.creatorId, userId),
                  eq(chatRoom.isPublic, false),
                  isNull(chatRoom.deletedAt),
                ),
              );
            if (Number(total) >= MAX_PRIVATE_ROOMS_PER_PLAYER) {
              throw new ChatRoomLimitReachedError();
            }

            const [room] = await t
              .insert(chatRoom)
              .values({
                name,
                slug,
                category: 'private-channels',
                isPublic: false,
                joinCode,
                creatorId: userId,
              })
              .returning();
            await t.insert(chatRoomConfiguration).values({ roomId: room.id });
            await t
              .insert(chatRoomMember)
              .values({ roomId: room.id, userId, role: 'owner' })
              .onConflictDoNothing();
            return room;
          }),
        );
        this.events.emit('chat.private_room.created', {
          roomId: record.id,
          creatorId: userId,
          playerId,
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
        return toRoom(record);
      } catch (e) {
        if (attempt < 3 && isUniqueConstraintViolation(e)) {
          continue;
        }
        throw e;
      }
    }
    // unreachable: loop returns or rethrows on every iteration
    throw new ChatRoomSlugConflictError();
  }

  async postSystemMessage(args: {
    roomId: ChatRoom['id'] | null;
    actorId: User['id'];
    username: User['name'];
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<ChatSystemMessage> {
    const db = (args.tx as DrizzleDb | undefined) ?? this.drizzle.db;
    const [record] = await db
      .insert(chatMessage)
      .values({
        roomId: args.roomId,
        userId: args.actorId,
        username: args.username,
        content: '',
        type: 'system',
        metadata: args.metadata,
      })
      .returning();
    const msg = toSystemMessage(record);
    // Only auto-publish when this call owns the write (no caller-managed transaction).
    // When `tx` is passed, the caller's transaction hasn't committed yet - publishing
    // here would leak a message to clients before (or even if) it actually commits.
    // The caller must publish itself after its transaction resolves.
    if (!args.tx) {
      publishChatEvent(this.transport, args.roomId, msg);
    }
    return msg;
  }

  async updateSystemMessage(args: {
    messageId: ChatMessage['id'];
    metadata: CommandMetadata;
    tx?: unknown;
  }): Promise<CommandChatMessage> {
    const db = (args.tx as DrizzleDb | undefined) ?? this.drizzle.db;
    const [record] = await db
      .update(chatMessage)
      .set({ metadata: args.metadata })
      .where(eq(chatMessage.id, args.messageId))
      .returning();
    const message = toSystemMessage(record);
    if (!args.tx) {
      publishChatEvent(this.transport, message.roomId, message);
    }
    return message as CommandChatMessage;
  }

  async listRoomMembers({ roomId, viewerId }: { roomId: ChatRoom['id']; viewerId?: User['id'] }) {
    await this.verifyRoomAccess(roomId, viewerId);
    const canSeeAdminUsers = viewerId ? await this.canSeeAdminUsers(viewerId) : false;
    const members = await this.drizzle.db
      .select({
        userId: chatRoomMember.userId,
        role: chatRoomMember.role,
        joinedAt: chatRoomMember.joinedAt,
        username: user.name,
      })
      .from(chatRoomMember)
      .leftJoin(user, eq(user.id, chatRoomMember.userId))
      .where(
        and(
          eq(chatRoomMember.roomId, roomId),
          canSeeAdminUsers
            ? undefined
            : or(isNull(user.id), notInArray(user.role, ['admin', 'super-admin'])),
        ),
      )
      .orderBy(asc(chatRoomMember.joinedAt));
    const summaries = await this.directory.lookupPlayers(members.map((m) => m.userId));
    const usernameByUserId = new Map(summaries.map((s) => [s.userId, s.username]));
    return members.map((m) =>
      serializeRow(
        { ...m, username: usernameByUserId.get(m.userId) ?? m.username ?? null },
        { dateFields: ['joinedAt'] },
      ),
    );
  }

  private async canSeeAdminUsers(viewerId: User['id']) {
    const [viewer] = await this.drizzle.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, viewerId))
      .limit(1);
    return viewer?.role === 'admin' || viewer?.role === 'super-admin';
  }
}
