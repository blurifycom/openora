import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  DrizzleService,
  mapConcurrent,
  serializeRow,
  withAdvisoryXactLock,
} from '@openora/core/server';
import type {
  AuditWritePort,
  ChatModerationRoomId,
  ChatPlatformBan,
  ChatModerationScope,
  ClientMeta,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { chatPlatformBan, chatRoom, chatRoomMember } from '../schema/index.js';
import {
  ChatAdminPrivateRoomModerationError,
  ChatRoomNotFoundError,
} from './errors/chat-moderation.errors.js';
import { revokeChannelBestEffort, ROOM_REVOKE_CONCURRENCY } from './channel-revoke.service.js';

export class ChatBanService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
    private readonly transport?: RealtimeTransport,
  ) {}

  async ban({
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
    if (concreteRoomId || scope === GLOBAL_CHAT_ROOM_ID) {
      const [room] = await this.drizzle.db
        .select({ id: chatRoom.id, isPublic: chatRoom.isPublic })
        .from(chatRoom)
        .where(
          and(
            concreteRoomId
              ? eq(chatRoom.id, concreteRoomId)
              : eq(chatRoom.slug, GLOBAL_CHAT_ROOM_ID),
            isNull(chatRoom.deletedAt),
          ),
        )
        .limit(1);
      if (!room) {
        throw new ChatRoomNotFoundError(concreteRoomId ?? GLOBAL_CHAT_ROOM_ID);
      }
      if (!room.isPublic) {
        throw new ChatAdminPrivateRoomModerationError();
      }
    }
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    const created = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-platform-ban:${userId}`, async () => {
        const now = new Date();
        const [existing] = await t
          .select({ id: chatPlatformBan.id, expiresAt: chatPlatformBan.expiresAt })
          .from(chatPlatformBan)
          .where(
            and(
              eq(chatPlatformBan.userId, userId),
              eq(chatPlatformBan.scope, scope),
              concreteRoomId
                ? eq(chatPlatformBan.roomId, concreteRoomId)
                : isNull(chatPlatformBan.roomId),
              isNull(chatPlatformBan.liftedAt),
            ),
          )
          .limit(1);
        if (existing && (!existing.expiresAt || existing.expiresAt > now)) {
          return existing;
        }
        if (existing) {
          await t
            .update(chatPlatformBan)
            .set({ liftedAt: now, liftedBy: actorId })
            .where(eq(chatPlatformBan.id, existing.id));
        }
        const [inserted] = await t
          .insert(chatPlatformBan)
          .values({ userId, bannedBy: actorId, roomId: concreteRoomId, scope, reason, expiresAt })
          .returning();
        return inserted;
      }),
    );
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.platform_ban.created',
      resourceType: 'chat_platform_ban',
      resourceId: created?.id ?? null,
      after: { userId, roomId, reason, expiresAt: expiresAt?.toISOString() ?? null },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    await this.revokeChannels(userId, await this.roomsToRevoke(userId, scope, concreteRoomId));
    return { success: true } as const;
  }

  // `null` is the global channel.
  private async roomsToRevoke(
    userId: Uuid,
    scope: ChatModerationScope,
    concreteRoomId: Uuid | null,
  ): Promise<(Uuid | null)[]> {
    if (concreteRoomId) {
      return [concreteRoomId];
    }
    if (scope === '__global') {
      return [null];
    }
    const memberRoomIds = this.drizzle.db
      .select({ roomId: chatRoomMember.roomId })
      .from(chatRoomMember)
      .where(eq(chatRoomMember.userId, userId));
    const rooms = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(
        and(
          isNull(chatRoom.deletedAt),
          scope === '__all'
            ? or(eq(chatRoom.isPublic, true), inArray(chatRoom.id, memberRoomIds))
            : eq(chatRoom.isPublic, true),
        ),
      );
    return [null, ...rooms.map(({ id }) => id)];
  }

  private async revokeChannels(userId: Uuid, roomIds: (Uuid | null)[]) {
    await mapConcurrent(roomIds, ROOM_REVOKE_CONCURRENCY, (roomId) =>
      revokeChannelBestEffort(this.transport, userId, roomId),
    );
  }

  async unban({
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
    const [lifted] = await this.drizzle.db
      .update(chatPlatformBan)
      .set({ liftedAt, liftedBy: actorId })
      .where(
        and(
          eq(chatPlatformBan.userId, userId),
          // Same predicate listBans and assertCanSend apply: a lapsed ban is not active,
          // so there is nothing to lift. Without this an admin lifting a row that has
          // just expired puts both `expired` and `lifted` on its trail.
          or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, liftedAt)),
          eq(chatPlatformBan.scope, scope),
          concreteRoomId
            ? eq(chatPlatformBan.roomId, concreteRoomId)
            : isNull(chatPlatformBan.roomId),
          isNull(chatPlatformBan.liftedAt),
        ),
      )
      .returning({ id: chatPlatformBan.id });
    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'chat.platform_ban.lifted',
      resourceType: 'chat_platform_ban',
      resourceId: lifted?.id ?? null,
      after: { userId, roomId },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }

  async listBans(userId?: Uuid): Promise<ChatPlatformBan[]> {
    const rows = await this.drizzle.db
      .select({
        id: chatPlatformBan.id,
        userId: chatPlatformBan.userId,
        roomId: chatPlatformBan.roomId,
        scope: chatPlatformBan.scope,
        reason: chatPlatformBan.reason,
        createdAt: chatPlatformBan.createdAt,
        liftedAt: chatPlatformBan.liftedAt,
        bannedUntil: chatPlatformBan.expiresAt,
      })
      .from(chatPlatformBan)
      .where(
        and(
          isNull(chatPlatformBan.liftedAt),
          or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, new Date())),
          userId ? eq(chatPlatformBan.userId, userId) : undefined,
        ),
      )
      .orderBy(desc(chatPlatformBan.createdAt));
    return rows.map((row) => ({
      ...serializeRow(row, { dateFields: ['createdAt', 'liftedAt', 'bannedUntil'] }),
      scope: row.scope as ChatModerationScope,
    }));
  }
}
