import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
import type { EventBus } from '@openora/core/server';
import type {
  AuditWritePort,
  ClientMeta,
  IdentityReader,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import { chatRoomBan, chatRoomMember } from '../schema/index.js';
import { retireLapsedRows } from './chat-moderation-expiry.service.js';
import {
  assertNotSelfModeration,
  assertRoomModerator,
  expiryFrom,
} from './chat-room-moderation.service.js';
import { revokeRoomChannelBestEffort } from './channel-revoke.service.js';
import { emitExpiredInvites, expireInvitesInvolving } from './chat-room-invite-expiry.service.js';

export class ChatRoomBanService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly audit: AuditWritePort,
    private readonly transport: RealtimeTransport,
    private readonly identityReader: IdentityReader,
  ) {}

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
    assertNotSelfModeration(moderatorId, userId);
    const expiresAt = expiryFrom(durationSeconds);
    const { replaced, expired } = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        await assertRoomModerator(t, roomId, moderatorId, userId);
        const now = new Date();
        const targetBans = and(
          eq(chatRoomBan.roomId, roomId),
          eq(chatRoomBan.userId, userId),
          isNull(chatRoomBan.liftedAt),
        );
        await retireLapsedRows(t, chatRoomBan, targetBans, now);
        const [previous] = await t
          .update(chatRoomBan)
          .set({ liftedAt: now, liftedBy: moderatorId })
          .where(targetBans)
          .returning({ id: chatRoomBan.id, expiresAt: chatRoomBan.expiresAt });
        await t.insert(chatRoomBan).values({ roomId, userId, bannedBy: moderatorId, expiresAt });
        await t
          .delete(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
        return {
          replaced: previous
            ? { banId: previous.id, expiresAt: previous.expiresAt?.toISOString() ?? null }
            : null,
          expired: await expireInvitesInvolving(t, userId, roomId),
        };
      }),
    );
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(moderatorId);
    emitExpiredInvites(this.events, expired, {
      actorId: moderatorId,
      actorPlayerId: playerId,
      ip,
      userAgent,
    });
    this.events.emit('chat.room.member.banned', {
      roomId,
      userId,
      bannedBy: moderatorId,
      playerId,
      reason,
      expiresAt: expiresAt?.toISOString() ?? null,
      replaced,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    await revokeRoomChannelBestEffort(this.drizzle.db, this.transport, userId, roomId);
    return { success: true } as const;
  }

  async unbanMember({
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
        await assertRoomModerator(t, roomId, moderatorId);
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
          .returning({ id: chatRoomBan.id, expiresAt: chatRoomBan.expiresAt });
        if (!lifted) {
          return;
        }
        await this.audit.recordInTransaction(t, {
          actorId: moderatorId,
          actorType: 'player',
          action: 'chat.room.member.unbanned',
          resourceType: 'chat_room_ban',
          resourceId: lifted.id,
          before: { expiresAt: lifted.expiresAt?.toISOString() ?? null },
          after: { roomId, userId },
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        });
      }),
    );
    return { success: true } as const;
  }
}
