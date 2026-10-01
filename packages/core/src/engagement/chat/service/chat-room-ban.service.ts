import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import type {
  AuditWritePort,
  ClientMeta,
  IdentityReader,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import { chatRoomBan, chatRoomMember } from '../schema/index.js';
import {
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
} from './errors/chat-moderation.errors.js';
import { revokeChannelBestEffort } from './channel-revoke.service.js';

export class ChatRoomBanService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly audit: AuditWritePort,
    private readonly transport: RealtimeTransport,
    private readonly identityReader: IdentityReader,
  ) {}

  private async assertModerator(
    db: DrizzleDb | DrizzleTx,
    roomId: Uuid,
    actorId: Uuid,
    targetId?: Uuid,
  ) {
    const [actor] = await db
      .select({ role: chatRoomMember.role })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, actorId)))
      .limit(1);
    if (!actor || (actor.role !== 'moderator' && actor.role !== 'owner')) {
      throw new ChatRoomNotModeratorError(roomId);
    }
    if (targetId) {
      const [target] = await db
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

  async banMember({
    moderatorId,
    roomId,
    userId,
    durationSeconds = null,
    reason = '',
    ip,
    userAgent,
  }: {
    moderatorId: Uuid;
    roomId: Uuid;
    userId: Uuid;
    durationSeconds?: number | null;
    reason?: string;
  } & ClientMeta) {
    if (moderatorId === userId) {
      throw new ChatRoomSelfModerationError();
    }
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    const replaced = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        await this.assertModerator(t, roomId, moderatorId, userId);
        const now = new Date();
        const [previous] = await t
          .update(chatRoomBan)
          .set({ liftedAt: now, liftedBy: moderatorId })
          .where(
            and(
              eq(chatRoomBan.roomId, roomId),
              eq(chatRoomBan.userId, userId),
              isNull(chatRoomBan.liftedAt),
            ),
          )
          .returning({ id: chatRoomBan.id, expiresAt: chatRoomBan.expiresAt });
        await t.insert(chatRoomBan).values({ roomId, userId, bannedBy: moderatorId, expiresAt });
        await t
          .delete(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
        return previous && (!previous.expiresAt || previous.expiresAt > now)
          ? { banId: previous.id, expiresAt: previous.expiresAt?.toISOString() ?? null }
          : null;
      }),
    );
    this.events.emit('chat.room.member.banned', {
      roomId,
      userId,
      bannedBy: moderatorId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(moderatorId),
      reason,
      expiresAt: expiresAt?.toISOString() ?? null,
      replaced,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    await revokeChannelBestEffort(this.transport, userId, roomId);
    return { success: true } as const;
  }

  async unbanMember({
    roomId,
    userId,
    moderatorId,
  }: {
    roomId: Uuid;
    userId: Uuid;
    moderatorId: Uuid;
  }) {
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        await this.assertModerator(t, roomId, moderatorId);
        const [lifted] = await t
          .update(chatRoomBan)
          .set({ liftedAt: new Date(), liftedBy: moderatorId })
          .where(
            and(
              eq(chatRoomBan.roomId, roomId),
              eq(chatRoomBan.userId, userId),
              isNull(chatRoomBan.liftedAt),
              or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, new Date())),
            ),
          )
          .returning({ id: chatRoomBan.id });
        if (!lifted) {
          return;
        }
        await this.audit.recordInTransaction(t, {
          actorId: moderatorId,
          actorType: 'player',
          action: 'chat.room.member.unbanned',
          resourceType: 'chat_room_ban',
          resourceId: lifted.id,
          after: { roomId, userId },
        });
      }),
    );
    return { success: true } as const;
  }
}
