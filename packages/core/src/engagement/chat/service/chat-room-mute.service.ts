import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { AuditWritePort, Uuid } from '@openora/core/contracts';
import { chatRoomMember, chatRoomMute } from '../schema/index.js';
import {
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
} from './errors/chat-moderation.errors.js';

export class ChatRoomMuteService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
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
  }

  async muteRoomMember({
    roomId,
    userId,
    moderatorId,
    durationSeconds = null,
    reason = '',
  }: {
    roomId: Uuid;
    userId: Uuid;
    moderatorId: Uuid;
    durationSeconds?: number | null;
    reason?: string;
  }) {
    if (moderatorId === userId) {
      throw new ChatRoomSelfModerationError();
    }
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        await this.assertModerator(t, roomId, moderatorId, userId);
        await t
          .update(chatRoomMute)
          .set({ liftedAt: new Date(), liftedBy: moderatorId })
          .where(
            and(
              eq(chatRoomMute.roomId, roomId),
              eq(chatRoomMute.userId, userId),
              isNull(chatRoomMute.liftedAt),
            ),
          );
        const [created] = await t
          .insert(chatRoomMute)
          .values({ roomId, userId, mutedBy: moderatorId, reason, expiresAt })
          .returning({ id: chatRoomMute.id });
        await this.audit.recordInTransaction(t, {
          actorId: moderatorId,
          actorType: 'player',
          action: 'chat.room.mute.created',
          resourceType: 'chat_room_mute',
          resourceId: created.id,
          after: { roomId, userId, durationSeconds, reason },
        });
      }),
    );
    return { success: true } as const;
  }

  async unmuteRoomMember({
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
        await this.assertModerator(t, roomId, moderatorId, userId);
        const [lifted] = await t
          .update(chatRoomMute)
          .set({ liftedAt: new Date(), liftedBy: moderatorId })
          .where(
            and(
              eq(chatRoomMute.roomId, roomId),
              eq(chatRoomMute.userId, userId),
              isNull(chatRoomMute.liftedAt),
              or(isNull(chatRoomMute.expiresAt), gt(chatRoomMute.expiresAt, new Date())),
            ),
          )
          .returning({ id: chatRoomMute.id });
        if (!lifted) {
          return;
        }
        await this.audit.recordInTransaction(t, {
          actorId: moderatorId,
          actorType: 'player',
          action: 'chat.room.mute.lifted',
          resourceType: 'chat_room_mute',
          resourceId: lifted.id,
          after: { roomId, userId },
        });
      }),
    );
    return { success: true } as const;
  }
}
