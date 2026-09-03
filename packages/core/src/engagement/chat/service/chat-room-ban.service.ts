import { and, eq, isNull } from 'drizzle-orm';
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

export class ChatRoomBanService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly audit: AuditWritePort,
    private readonly transport: RealtimeTransport,
    private readonly identityReader: IdentityReader,
  ) {}

  /**
   * Reads both roles through `db`, so a caller holding the room's advisory lock can pass its
   * transaction and have the authorization decided against rows nobody can move underneath it.
   */
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
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        // Inside the lock, not before it: an owner whose account is closing is demoted by the
        // ownership handover, and a check that ran before the lock would still let that request
        // through to ban the successor it just promoted, leaving the room without an owner.
        await this.assertModerator(t, roomId, moderatorId, userId);
        const [existing] = await t
          .select({ id: chatRoomBan.id, expiresAt: chatRoomBan.expiresAt })
          .from(chatRoomBan)
          .where(
            and(
              eq(chatRoomBan.roomId, roomId),
              eq(chatRoomBan.userId, userId),
              isNull(chatRoomBan.liftedAt),
            ),
          )
          .limit(1);
        if (existing && (!existing.expiresAt || existing.expiresAt > new Date())) {
          return;
        }
        if (existing) {
          await t
            .update(chatRoomBan)
            .set({ liftedAt: new Date(), liftedBy: moderatorId })
            .where(eq(chatRoomBan.id, existing.id));
        }
        await t.insert(chatRoomBan).values({
          roomId,
          userId,
          bannedBy: moderatorId,
          expiresAt:
            durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000),
        });
        await t
          .delete(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
      }),
    );
    this.events.emit('chat.room.member.banned', {
      roomId,
      userId,
      bannedBy: moderatorId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(moderatorId),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    await this.audit.record({
      actorId: moderatorId,
      actorType: 'player',
      action: 'chat.room.member.banned',
      resourceType: 'chat_room_ban',
      resourceId: null,
      after: { roomId, userId, durationSeconds, reason },
    });
    await this.transport.revokeUserFromChannel?.(userId, `chat:room:${roomId}`);
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
    await this.assertModerator(this.drizzle.db, roomId, moderatorId);
    await this.drizzle.db
      .update(chatRoomBan)
      .set({ liftedAt: new Date(), liftedBy: moderatorId })
      .where(
        and(
          eq(chatRoomBan.roomId, roomId),
          eq(chatRoomBan.userId, userId),
          isNull(chatRoomBan.liftedAt),
        ),
      );
    await this.audit.record({
      actorId: moderatorId,
      actorType: 'player',
      action: 'chat.room.member.unbanned',
      resourceType: 'chat_room_ban',
      resourceId: null,
      after: { roomId, userId },
    });
    return { success: true } as const;
  }
}
