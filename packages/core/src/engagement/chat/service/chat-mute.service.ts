import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { DrizzleService, serializeRow } from '@openora/core/server';
import type {
  AuditWritePort,
  ClientMeta,
  ChatModerationRoomId,
  Uuid,
} from '@openora/core/contracts';
import {
  chatMute,
  chatPlatformBan,
  chatRoomConfiguration,
  chatRoomMute,
  chatRoom,
} from '../schema/index.js';
import {
  ChatRoomNotFoundError,
  ChatAdminPrivateRoomModerationError,
  ChatPlayerMutedError,
  ChatPlayerBannedError,
} from './errors/chat-moderation.errors.js';

export class ChatMuteService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async assertCanSend(userId: Uuid, roomId: Uuid | null, isPublic = true) {
    const now = new Date();
    if (roomId !== null) {
      const [roomMute] = await this.drizzle.db
        .select({ id: chatRoomMute.id, expiresAt: chatRoomMute.expiresAt })
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
        throw new ChatPlayerMutedError(roomMute.expiresAt);
      }
      const [config] = await this.drizzle.db
        .select({ readOnlyMode: chatRoomConfiguration.readOnlyMode })
        .from(chatRoomConfiguration)
        .where(eq(chatRoomConfiguration.roomId, roomId))
        .limit(1);
      if (config?.readOnlyMode) {
        throw new ChatPlayerMutedError(null);
      }
      if (!isPublic) {
        return;
      }
    }
    const [ban] = await this.drizzle.db
      .select({ id: chatPlatformBan.id, expiresAt: chatPlatformBan.expiresAt })
      .from(chatPlatformBan)
      .where(
        and(
          eq(chatPlatformBan.userId, userId),
          isNull(chatPlatformBan.liftedAt),
          or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, now)),
          roomId === null
            ? or(
                eq(chatPlatformBan.scope, '__global'),
                eq(chatPlatformBan.scope, '__all_public'),
                eq(chatPlatformBan.scope, '__all'),
              )
            : isPublic
              ? or(
                  eq(chatPlatformBan.scope, '__all_public'),
                  eq(chatPlatformBan.scope, '__all'),
                  and(eq(chatPlatformBan.scope, 'room'), eq(chatPlatformBan.roomId, roomId)),
                )
              : or(
                  eq(chatPlatformBan.scope, '__all'),
                  and(eq(chatPlatformBan.scope, 'room'), eq(chatPlatformBan.roomId, roomId)),
                ),
          roomId !== null
            ? or(isNull(chatPlatformBan.roomId), eq(chatPlatformBan.roomId, roomId))
            : isNull(chatPlatformBan.roomId),
        ),
      )
      .limit(1);
    if (ban) {
      throw new ChatPlayerBannedError(ban.expiresAt);
    }
    const [mute] = await this.drizzle.db
      .select({ id: chatMute.id, expiresAt: chatMute.expiresAt })
      .from(chatMute)
      .where(
        and(
          eq(chatMute.userId, userId),
          isNull(chatMute.liftedAt),
          roomId === null
            ? eq(chatMute.scope, '__global')
            : or(
                eq(chatMute.scope, '__all'),
                eq(chatMute.scope, '__all_public'),
                or(
                  and(eq(chatMute.scope, 'room'), eq(chatMute.roomId, roomId)),
                  and(eq(chatMute.scope, '__global'), eq(chatMute.roomId, roomId)),
                ),
              ),
          or(isNull(chatMute.expiresAt), gt(chatMute.expiresAt, now)),
        ),
      )
      .limit(1);
    if (mute) {
      throw new ChatPlayerMutedError(mute.expiresAt);
    }
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
    roomId: ChatModerationRoomId;
    durationSeconds: number | null;
    reason: string;
    actorId: Uuid;
  } & ClientMeta) {
    const scope =
      roomId === '__global' || roomId === '__all_public' || roomId === '__all' ? roomId : 'room';
    const concreteRoomId = scope === 'room' ? roomId : null;
    if (concreteRoomId) {
      const [room] = await this.drizzle.db
        .select()
        .from(chatRoom)
        .where(and(eq(chatRoom.id, concreteRoomId), isNull(chatRoom.deletedAt)))
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
      .values({ userId, roomId: concreteRoomId, scope, mutedBy: actorId, reason, expiresAt })
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
  }: { userId: Uuid; roomId: ChatModerationRoomId; actorId: Uuid } & ClientMeta) {
    const scope =
      roomId === '__global' || roomId === '__all_public' || roomId === '__all' ? roomId : 'room';
    const concreteRoomId = scope === 'room' ? roomId : null;
    const liftedAt = new Date();
    const rows = await this.drizzle.db
      .update(chatMute)
      .set({ liftedAt, liftedBy: actorId })
      .where(
        and(
          eq(chatMute.userId, userId),
          scope === 'room'
            ? or(
                eq(chatMute.scope, 'room'),
                and(eq(chatMute.scope, '__global'), eq(chatMute.roomId, concreteRoomId ?? '')),
              )
            : eq(chatMute.scope, scope),
          concreteRoomId === null ? isNull(chatMute.roomId) : eq(chatMute.roomId, concreteRoomId),
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
        scope: chatMute.scope,
        reason: chatMute.reason,
        createdAt: chatMute.createdAt,
        expiresAt: chatMute.expiresAt,
      })
      .from(chatMute)
      .where(and(isNull(chatMute.liftedAt), userId ? eq(chatMute.userId, userId) : undefined))
      .orderBy(desc(chatMute.createdAt));
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt', 'expiresAt'] }));
  }
}
