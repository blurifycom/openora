import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import type { AuditWritePort, ClientMeta, Uuid } from '@openora/core/contracts';
import { chatRoomMember, chatRoomMute } from '../schema/index.js';
import { retireLapsedRows } from './chat-moderation-expiry.service.js';
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
    ip,
    userAgent,
  }: {
    roomId: Uuid;
    userId: Uuid;
    moderatorId: Uuid;
    durationSeconds?: number | null;
    reason?: string;
  } & ClientMeta) {
    if (moderatorId === userId) {
      throw new ChatRoomSelfModerationError();
    }
    const expiresAt =
      durationSeconds === null ? null : new Date(Date.now() + durationSeconds * 1000);
    await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        await this.assertModerator(t, roomId, moderatorId, userId);
        const now = new Date();
        const targetMutes = and(
          eq(chatRoomMute.roomId, roomId),
          eq(chatRoomMute.userId, userId),
          isNull(chatRoomMute.liftedAt),
        );
        await retireLapsedRows(t, chatRoomMute, targetMutes, now);
        const [previous] = await t
          .update(chatRoomMute)
          .set({ liftedAt: now, liftedBy: moderatorId })
          .where(targetMutes)
          .returning({
            id: chatRoomMute.id,
            reason: chatRoomMute.reason,
            expiresAt: chatRoomMute.expiresAt,
          });
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
          before: previous
            ? {
                muteId: previous.id,
                reason: previous.reason,
                expiresAt: previous.expiresAt?.toISOString() ?? null,
              }
            : null,
          after: { roomId, userId, durationSeconds, reason },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }

  async unmuteRoomMember({
    roomId,
    userId,
    moderatorId,
    ip,
    userAgent,
  }: {
    roomId: Uuid;
    userId: Uuid;
    moderatorId: Uuid;
  } & ClientMeta) {
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
          .returning({
            id: chatRoomMute.id,
            reason: chatRoomMute.reason,
            expiresAt: chatRoomMute.expiresAt,
          });
        if (!lifted) {
          return;
        }
        await this.audit.recordInTransaction(t, {
          actorId: moderatorId,
          actorType: 'player',
          action: 'chat.room.mute.lifted',
          resourceType: 'chat_room_mute',
          resourceId: lifted.id,
          before: { reason: lifted.reason, expiresAt: lifted.expiresAt?.toISOString() ?? null },
          after: { roomId, userId },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }
}
