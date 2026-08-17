import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { DrizzleService, serializeRow } from '@openora/core/server';
import type {
  AuditWritePort,
  ChatModerationRoomId,
  ClientMeta,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import { chatChannel } from '@openora/core/contracts';
import { chatPlatformBan, chatRoom } from '../schema/index.js';

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
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    const [created] = await this.drizzle.db
      .insert(chatPlatformBan)
      .values({ userId, bannedBy: actorId, roomId: concreteRoomId, scope, reason, expiresAt })
      .onConflictDoNothing()
      .returning();
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
    if (concreteRoomId) {
      await this.transport?.revokeClientFromChannel?.(userId, `chat:room:${concreteRoomId}`);
    } else if (scope === '__global') {
      await this.transport?.revokeClientFromChannel?.(userId, chatChannel(null));
    } else if (scope === '__all_public') {
      const publicRooms = await this.drizzle.db
        .select({ id: chatRoom.id })
        .from(chatRoom)
        .where(and(eq(chatRoom.isPublic, true), isNull(chatRoom.deletedAt)));
      await Promise.all([
        this.transport?.revokeClientFromChannel?.(userId, chatChannel(null)),
        ...publicRooms.map(({ id }) =>
          this.transport?.revokeClientFromChannel?.(userId, `chat:room:${id}`),
        ),
      ]);
    } else if (scope === '__all') {
      await this.transport?.revokeClient?.(userId);
    }
    return { success: true } as const;
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
    const [lifted] = await this.drizzle.db
      .update(chatPlatformBan)
      .set({ liftedAt: new Date(), liftedBy: actorId })
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

  async listBans(userId?: Uuid) {
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
    return rows.map((row) =>
      serializeRow(row, { dateFields: ['createdAt', 'liftedAt', 'bannedUntil'] }),
    );
  }
}
