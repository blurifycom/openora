import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import {
  DrizzleService,
  createLogger,
  mapConcurrent,
  serializeRow,
  withAdvisoryXactLock,
} from '@openora/core/server';
import type {
  AuditWritePort,
  ChatModerationRoomId,
  ChatPlatformBan,
  ChatModerationScope,
  ChatModerationUserFilter,
  ClientMeta,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import { chatPlatformBan, chatRoom, chatRoomMember } from '../schema/index.js';
import {
  moderatedUserFilter,
  resolveModerationTarget,
  type ModerationTarget,
} from '../moderation/index.js';
import { revokeChannelBestEffort, ROOM_REVOKE_CONCURRENCY } from './channel-revoke.service.js';
import { retireLapsedRows } from './chat-moderation-expiry.service.js';

const logger = createLogger('chat');

function activeBanFilter(userId: Uuid, target: ModerationTarget) {
  return and(
    eq(chatPlatformBan.userId, userId),
    eq(chatPlatformBan.scope, target.scope),
    target.roomId ? eq(chatPlatformBan.roomId, target.roomId) : isNull(chatPlatformBan.roomId),
    isNull(chatPlatformBan.liftedAt),
  );
}

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
    const target = await resolveModerationTarget(this.drizzle.db, roomId, { validate: true });
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-platform-ban:${userId}`, async () => {
        const now = new Date();
        await retireLapsedRows(t, chatPlatformBan, activeBanFilter(userId, target), now);
        const [previous] = await t
          .update(chatPlatformBan)
          .set({ liftedAt: now, liftedBy: actorId })
          .where(activeBanFilter(userId, target))
          .returning({
            id: chatPlatformBan.id,
            reason: chatPlatformBan.reason,
            expiresAt: chatPlatformBan.expiresAt,
          });
        const [created] = await t
          .insert(chatPlatformBan)
          .values({
            userId,
            bannedBy: actorId,
            roomId: target.roomId,
            scope: target.scope,
            reason,
            expiresAt,
          })
          .returning({ id: chatPlatformBan.id });
        await this.audit.recordInTransaction(t, {
          actorId,
          actorType: 'admin',
          action: 'chat.platform_ban.created',
          resourceType: 'chat_platform_ban',
          resourceId: created.id,
          before: previous
            ? {
                banId: previous.id,
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
    // The ban is committed; failing to list its channels must not turn it into a 500 and a retry.
    await this.roomsToRevoke(userId, target)
      .then((roomIds) => this.revokeChannels(userId, roomIds))
      .catch((err: unknown) => {
        logger.error({ err, userId, scope: target.scope }, 'chat ban channel revoke failed');
      });
    return { success: true } as const;
  }

  // `null` is the global channel.
  private async roomsToRevoke(userId: Uuid, target: ModerationTarget): Promise<(Uuid | null)[]> {
    if (target.scope !== '__all_public' && target.scope !== '__all') {
      return [target.roomId];
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
          target.scope === '__all'
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
    const target = await resolveModerationTarget(this.drizzle.db, roomId, { validate: false });
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-platform-ban:${userId}`, async () => {
        const liftedAt = new Date();
        const [lifted] = await t
          .update(chatPlatformBan)
          .set({ liftedAt, liftedBy: actorId })
          .where(
            and(
              activeBanFilter(userId, target),
              or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, liftedAt)),
            ),
          )
          .returning({
            id: chatPlatformBan.id,
            reason: chatPlatformBan.reason,
            expiresAt: chatPlatformBan.expiresAt,
          });
        if (!lifted) {
          return;
        }
        await this.audit.recordInTransaction(t, {
          actorId,
          actorType: 'admin',
          action: 'chat.platform_ban.lifted',
          resourceType: 'chat_platform_ban',
          resourceId: lifted.id,
          before: { reason: lifted.reason, expiresAt: lifted.expiresAt?.toISOString() ?? null },
          after: { userId, scope: target.scope, roomId: target.roomId },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }

  async listBans(users?: ChatModerationUserFilter): Promise<ChatPlatformBan[]> {
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
          moderatedUserFilter(chatPlatformBan.userId, users),
        ),
      )
      .orderBy(desc(chatPlatformBan.createdAt));
    return rows.map((row) => ({
      ...serializeRow(row, { dateFields: ['createdAt', 'liftedAt', 'bannedUntil'] }),
      scope: row.scope as ChatModerationScope,
    }));
  }
}
