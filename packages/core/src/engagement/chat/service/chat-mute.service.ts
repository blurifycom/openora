import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { DrizzleService, serializeRow, withAdvisoryXactLock } from '@openora/core/server';
import {
  GLOBAL_CHAT_ROOM_ID,
  type AuditWritePort,
  type ClientMeta,
  type ChatModerationRoomId,
  type ChatModerationEntry,
  type ChatModerationScope,
  type Uuid,
} from '@openora/core/contracts';
import {
  chatMessage,
  chatMute,
  chatPlatformBan,
  chatRoomConfiguration,
  chatRoomMember,
  chatRoomMute,
  chatRoom,
} from '../schema/index.js';
import { ChatPlayerMutedError, ChatPlayerBannedError } from './errors/chat-moderation.errors.js';
import { resolveModerationTarget } from '../moderation/index.js';

export class ChatMuteService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async assertCanSend(userId: Uuid, roomId: Uuid | null, isPublic = true) {
    const now = new Date();
    const configColumns = {
      roomId: chatRoomConfiguration.roomId,
      readOnlyMode: chatRoomConfiguration.readOnlyMode,
      slowMode: chatRoomConfiguration.slowMode,
      slowModeSeconds: chatRoomConfiguration.slowModeSeconds,
    };
    const [config] =
      roomId === null
        ? await this.drizzle.db
            .select(configColumns)
            .from(chatRoomConfiguration)
            .innerJoin(chatRoom, eq(chatRoomConfiguration.roomId, chatRoom.id))
            .where(and(eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID), isNull(chatRoom.deletedAt)))
            .limit(1)
        : await this.drizzle.db
            .select(configColumns)
            .from(chatRoomConfiguration)
            .where(eq(chatRoomConfiguration.roomId, roomId))
            .limit(1);
    if (config?.readOnlyMode) {
      throw new ChatPlayerMutedError(null);
    }
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
            ? or(
                eq(chatMute.scope, '__global'),
                eq(chatMute.scope, '__all_public'),
                eq(chatMute.scope, '__all'),
              )
            : or(
                eq(chatMute.scope, '__all'),
                ...(isPublic ? [eq(chatMute.scope, '__all_public')] : []),
                and(eq(chatMute.scope, 'room'), eq(chatMute.roomId, roomId)),
              ),
          or(isNull(chatMute.expiresAt), gt(chatMute.expiresAt, now)),
        ),
      )
      .limit(1);
    if (mute) {
      throw new ChatPlayerMutedError(mute.expiresAt);
    }
    if (config?.slowMode && config.slowModeSeconds > 0) {
      await this.assertSlowModeElapsed(userId, roomId, config);
    }
  }

  private async assertSlowModeElapsed(
    userId: Uuid,
    roomId: Uuid | null,
    config: { roomId: Uuid; slowModeSeconds: number },
  ) {
    const windowMs = config.slowModeSeconds * 1000;
    const [last] = await this.drizzle.db
      .select({ createdAt: chatMessage.createdAt })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.userId, userId),
          roomId === null ? isNull(chatMessage.roomId) : eq(chatMessage.roomId, roomId),
          eq(chatMessage.type, 'user'),
          gt(chatMessage.createdAt, new Date(Date.now() - windowMs)),
        ),
      )
      .orderBy(desc(chatMessage.createdAt))
      .limit(1);
    if (!last) {
      return;
    }
    const [moderator] = await this.drizzle.db
      .select({ id: chatRoomMember.id })
      .from(chatRoomMember)
      .where(
        and(
          eq(chatRoomMember.roomId, config.roomId),
          eq(chatRoomMember.userId, userId),
          inArray(chatRoomMember.role, ['moderator', 'owner']),
        ),
      )
      .limit(1);
    if (!moderator) {
      throw new ChatPlayerMutedError(new Date(last.createdAt.getTime() + windowMs));
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
    const target = await resolveModerationTarget(this.drizzle.db, roomId, { validate: true });
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-mute:${userId}`, async () => {
        const now = new Date();
        const [previous] = await t
          .update(chatMute)
          .set({ liftedAt: now, liftedBy: actorId })
          .where(
            and(
              eq(chatMute.userId, userId),
              eq(chatMute.scope, target.scope),
              target.roomId ? eq(chatMute.roomId, target.roomId) : isNull(chatMute.roomId),
              isNull(chatMute.liftedAt),
            ),
          )
          .returning({ id: chatMute.id, reason: chatMute.reason, expiresAt: chatMute.expiresAt });
        const [created] = await t
          .insert(chatMute)
          .values({
            userId,
            roomId: target.roomId,
            scope: target.scope,
            mutedBy: actorId,
            reason,
            expiresAt,
          })
          .returning({ id: chatMute.id });
        const previousActive = previous && (!previous.expiresAt || previous.expiresAt > now);
        await this.audit.recordInTransaction(t, {
          actorId,
          actorType: 'admin',
          action: 'chat.mute.created',
          resourceType: 'chat_mute',
          resourceId: created.id,
          before: previousActive
            ? {
                muteId: previous.id,
                reason: previous.reason,
                expiresAt: previous.expiresAt?.toISOString() ?? null,
              }
            : null,
          after: {
            userId,
            scope: target.scope,
            roomId: target.roomId,
            reason,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }

  async unmute({
    userId,
    roomId,
    actorId,
    ip,
    userAgent,
  }: { userId: Uuid; roomId: ChatModerationRoomId; actorId: Uuid } & ClientMeta) {
    const { scope, roomId: concreteRoomId } = await resolveModerationTarget(
      this.drizzle.db,
      roomId,
      { validate: false },
    );
    const liftedAt = new Date();
    await this.drizzle.db.transaction(async (t) => {
      const rows = await t
        .update(chatMute)
        .set({ liftedAt, liftedBy: actorId })
        .where(
          and(
            eq(chatMute.userId, userId),
            or(isNull(chatMute.expiresAt), gt(chatMute.expiresAt, liftedAt)),
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
      if (rows.length === 0) {
        return;
      }
      await this.audit.recordInTransaction(t, {
        actorId,
        actorType: 'admin',
        action: 'chat.mute.lifted',
        resourceType: 'chat_mute',
        resourceId: rows[0]?.id ?? null,
        after: { userId, scope, roomId: concreteRoomId, liftedAt: liftedAt.toISOString() },
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    });
    return { success: true } as const;
  }

  async listMutes(userId?: Uuid): Promise<ChatModerationEntry[]> {
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
      .where(
        and(
          isNull(chatMute.liftedAt),
          // Mirrors listBans and the three assertCanSend checks: expiry is a read-time
          // predicate, so a listing that omits it reports a player as muted after the
          // duration has run out - while chat itself already lets them post.
          or(isNull(chatMute.expiresAt), gt(chatMute.expiresAt, new Date())),
          userId ? eq(chatMute.userId, userId) : undefined,
        ),
      )
      .orderBy(desc(chatMute.createdAt));
    return rows.map((row) => ({
      ...serializeRow(row, { dateFields: ['createdAt', 'expiresAt'] }),
      scope: row.scope as ChatModerationScope,
    }));
  }
}
