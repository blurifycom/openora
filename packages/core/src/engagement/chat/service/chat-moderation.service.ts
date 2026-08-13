import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  makeNotFoundError,
  serializeRow,
} from '@openora/core/server';
import type {
  AuditWritePort,
  ChatModeration,
  ClientMeta,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import type { ChatMessage } from '../contract/index.js';
import {
  chatMessage,
  chatMute,
  chatPlatformBan,
  chatRoom,
  chatRoomConfiguration,
  chatRoomMute,
} from '../schema/index.js';

export const ChatRoomNotFoundError = makeNotFoundError('ChatRoom');
export const ChatMessageNotFoundError = makeNotFoundError('ChatMessage');
export const ChatPlayerMutedError = createDomainError(
  'ChatPlayerMutedError',
  () => 'You are muted in this chat channel',
);
export const ChatPlayerBannedError = createDomainError(
  'ChatPlayerBannedError',
  () => 'You are banned from public chat',
);
export const ChatAdminPrivateRoomModerationError = createDomainError(
  'ChatAdminPrivateRoomModerationError',
  () => 'Admin mutes only apply to global or public chat rooms',
);

function toMessage(record: typeof chatMessage.$inferSelect) {
  return serializeRow(record, { dateFields: ['createdAt'] });
}

function toPublicMessage(record: typeof chatMessage.$inferSelect): ChatMessage {
  if (record.type === 'system') {
    return { ...toMessage(record), actorId: record.userId } as ChatMessage;
  }
  return toMessage(record) as ChatMessage;
}

export class ChatModerationService implements ChatModeration {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly transport: RealtimeTransport,
    private readonly audit: AuditWritePort,
  ) {}

  async assertCanSend(userId: Uuid, roomId: Uuid | null, isPublic = true) {
    const now = new Date();
    if (roomId !== null) {
      const [roomMute] = await this.drizzle.db
        .select({ id: chatRoomMute.id })
        .from(chatRoomMute)
        .where(
          and(
            eq(chatRoomMute.userId, userId),
            eq(chatRoomMute.roomId, roomId),
            isNull(chatRoomMute.liftedAt),
            or(isNull(chatRoomMute.expiresAt), gt(chatRoomMute.expiresAt, now)),
          ),
        )
        .limit(1);
      if (roomMute) {
        throw new ChatPlayerMutedError();
      }
      const [config] = await this.drizzle.db
        .select({ readOnlyMode: chatRoomConfiguration.readOnlyMode })
        .from(chatRoomConfiguration)
        .where(eq(chatRoomConfiguration.roomId, roomId))
        .limit(1);
      if (config?.readOnlyMode) {
        throw new ChatPlayerMutedError();
      }
      if (!isPublic) {
        return;
      }
    }
    const [ban] = await this.drizzle.db
      .select({ id: chatPlatformBan.id })
      .from(chatPlatformBan)
      .where(and(eq(chatPlatformBan.userId, userId), isNull(chatPlatformBan.liftedAt)))
      .limit(1);
    if (ban) {
      throw new ChatPlayerBannedError();
    }
    const [mute] = await this.drizzle.db
      .select({ id: chatMute.id })
      .from(chatMute)
      .where(
        and(
          eq(chatMute.userId, userId),
          isNull(chatMute.liftedAt),
          roomId === null ? isNull(chatMute.roomId) : eq(chatMute.roomId, roomId),
          or(isNull(chatMute.expiresAt), gt(chatMute.expiresAt, new Date())),
        ),
      )
      .limit(1);
    if (mute) {
      throw new ChatPlayerMutedError();
    }
  }

  async deleteMessage(id: ChatMessage['id'], actorId: Uuid, meta?: ClientMeta) {
    const message = findOneOrThrow(
      await this.drizzle.db.select().from(chatMessage).where(eq(chatMessage.id, id)),
      new ChatMessageNotFoundError(id),
    );
    if (!message.isDeleted) {
      await this.drizzle.db
        .update(chatMessage)
        .set({ isDeleted: true })
        .where(and(eq(chatMessage.id, id), eq(chatMessage.isDeleted, false)));
      void Promise.resolve(
        this.transport.publish(chatChannel(message.roomId), {
          ...toPublicMessage(message),
          isDeleted: true,
        }),
      );
    }
    await this.audit.record({
      actorId,
      actorType: 'admin',
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

  async mute({
    userId,
    roomId,
    durationSeconds,
    reason,
    actorId,
    ip,
    userAgent,
  }: {
    userId: Uuid;
    roomId: Uuid | null;
    durationSeconds: number | null;
    reason: string;
    actorId: Uuid;
  } & ClientMeta) {
    if (roomId) {
      const [room] = await this.drizzle.db
        .select()
        .from(chatRoom)
        .where(and(eq(chatRoom.id, roomId), isNull(chatRoom.deletedAt)))
        .limit(1);
      if (!room) {
        throw new ChatRoomNotFoundError(roomId);
      }
      if (!room.isPublic) {
        throw new ChatAdminPrivateRoomModerationError();
      }
    }
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    const [created] = await this.drizzle.db
      .insert(chatMute)
      .values({ userId, roomId, mutedBy: actorId, reason, expiresAt })
      .returning();
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.mute.created',
      resourceType: 'chat_mute',
      resourceId: created.id,
      after: { userId, roomId, reason, expiresAt: expiresAt?.toISOString() ?? null },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }

  async unmute({
    userId,
    roomId,
    actorId,
    ip,
    userAgent,
  }: {
    userId: Uuid;
    roomId: Uuid | null;
    actorId: Uuid;
  } & ClientMeta) {
    const liftedAt = new Date();
    const rows = await this.drizzle.db
      .update(chatMute)
      .set({ liftedAt, liftedBy: actorId })
      .where(
        and(
          eq(chatMute.userId, userId),
          roomId === null ? isNull(chatMute.roomId) : eq(chatMute.roomId, roomId),
          isNull(chatMute.liftedAt),
        ),
      )
      .returning({ id: chatMute.id });
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.mute.lifted',
      resourceType: 'chat_mute',
      resourceId: rows[0]?.id ?? null,
      after: { userId, roomId, liftedAt: liftedAt.toISOString() },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }

  async listMutes(userId?: Uuid) {
    const rows = await this.drizzle.db
      .select({
        id: chatMute.id,
        userId: chatMute.userId,
        roomId: chatMute.roomId,
        reason: chatMute.reason,
        createdAt: chatMute.createdAt,
        expiresAt: chatMute.expiresAt,
      })
      .from(chatMute)
      .where(and(isNull(chatMute.liftedAt), userId ? eq(chatMute.userId, userId) : undefined))
      .orderBy(desc(chatMute.createdAt));
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt', 'expiresAt'] }));
  }

  async ban({
    userId,
    reason,
    actorId,
    ip,
    userAgent,
  }: {
    userId: Uuid;
    reason: string;
    actorId: Uuid;
  } & ClientMeta) {
    const [created] = await this.drizzle.db
      .insert(chatPlatformBan)
      .values({ userId, bannedBy: actorId, reason })
      .onConflictDoNothing()
      .returning();
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.platform_ban.created',
      resourceType: 'chat_platform_ban',
      resourceId: created?.id ?? null,
      after: { userId, reason },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    await this.transport.revokeClient?.(userId);
    return { success: true } as const;
  }

  async unban({
    userId,
    actorId,
    ip,
    userAgent,
  }: {
    userId: Uuid;
    actorId: Uuid;
  } & ClientMeta) {
    const [lifted] = await this.drizzle.db
      .update(chatPlatformBan)
      .set({ liftedAt: new Date(), liftedBy: actorId })
      .where(and(eq(chatPlatformBan.userId, userId), isNull(chatPlatformBan.liftedAt)))
      .returning({ id: chatPlatformBan.id });
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.platform_ban.lifted',
      resourceType: 'chat_platform_ban',
      resourceId: lifted?.id ?? null,
      after: { userId },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }

  async listBans(userId?: Uuid) {
    const rows = await this.drizzle.db
      .select({
        id: chatPlatformBan.id,
        userId: chatPlatformBan.userId,
        reason: chatPlatformBan.reason,
        createdAt: chatPlatformBan.createdAt,
        liftedAt: chatPlatformBan.liftedAt,
      })
      .from(chatPlatformBan)
      .where(
        and(
          isNull(chatPlatformBan.liftedAt),
          userId ? eq(chatPlatformBan.userId, userId) : undefined,
        ),
      )
      .orderBy(desc(chatPlatformBan.createdAt));
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt', 'liftedAt'] }));
  }
}
