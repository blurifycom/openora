import { and, eq, isNull } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
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

  private async assertModerator(roomId: Uuid, actorId: Uuid, targetId?: Uuid) {
    const [actor] = await this.drizzle.db
      .select({ role: chatRoomMember.role })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, actorId)))
      .limit(1);
    if (!actor || (actor.role !== 'moderator' && actor.role !== 'owner')) {
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
    await this.assertModerator(roomId, moderatorId, userId);
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    const created = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room-mute:${roomId}:${userId}`, async () => {
        const now = new Date();
        const [active] = await t
          .select({ id: chatRoomMute.id, expiresAt: chatRoomMute.expiresAt })
          .from(chatRoomMute)
          .where(
            and(
              eq(chatRoomMute.roomId, roomId),
              eq(chatRoomMute.userId, userId),
              isNull(chatRoomMute.liftedAt),
            ),
          )
          .limit(1);
        if (active && (!active.expiresAt || active.expiresAt > now)) {
          return null;
        }
        if (active) {
          await t
            .update(chatRoomMute)
            .set({ liftedAt: now, liftedBy: moderatorId })
            .where(eq(chatRoomMute.id, active.id));
        }
        const [inserted] = await t
          .insert(chatRoomMute)
          .values({ roomId, userId, mutedBy: moderatorId, reason, expiresAt })
          .returning({ id: chatRoomMute.id });
        return inserted;
      }),
    );
    if (created) {
      await this.audit.record({
        actorId: moderatorId,
        actorType: 'player',
        action: 'chat.room.mute.created',
        resourceType: 'chat_room_mute',
        resourceId: created?.id ?? null,
        after: { roomId, userId, durationSeconds, reason },
      });
    }
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
    await this.assertModerator(roomId, moderatorId, userId);
    await this.drizzle.db
      .update(chatRoomMute)
      .set({ liftedAt: new Date(), liftedBy: moderatorId })
      .where(
        and(
          eq(chatRoomMute.roomId, roomId),
          eq(chatRoomMute.userId, userId),
          isNull(chatRoomMute.liftedAt),
        ),
      );
    await this.audit.record({
      actorId: moderatorId,
      actorType: 'player',
      action: 'chat.room.mute.lifted',
      resourceType: 'chat_room_mute',
      resourceId: null,
      after: { roomId, userId },
    });
    return { success: true } as const;
  }
}
