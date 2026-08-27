import { and, count, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { DrizzleService, withAdvisoryXactLock, serializeRow } from '@openora/core/server';
import type { EventBus } from '@openora/core/server';
import {
  chatChannel,
  type AuditWritePort,
  type ClientMeta,
  type IdentityReader,
  type RealtimeTransport,
  type Uuid,
} from '@openora/core/contracts';
import { chatRoom, chatRoomBan, chatRoomMember, chatRoomRemove } from '../schema/index.js';
import type { ChatRoomAssignableRole } from '../contract/index.js';
import {
  ChatRoomBannedError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomLastModeratorError,
  ChatRoomNotFoundError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomSelfModerationError,
} from './errors/chat-moderation.errors.js';

const MODERATOR_ROLES = ['moderator', 'owner'] as const;

function toRoom(record: typeof chatRoom.$inferSelect) {
  const { deletedAt: _deletedAt, ...room } = record;
  return serializeRow(
    { ...room, isBanned: false, bannedUntil: null },
    { dateFields: ['createdAt', 'bannedUntil'] },
  );
}

export class ChatRoomMembershipService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly audit: AuditWritePort,
    private readonly transport: RealtimeTransport,
    private readonly identityReader: IdentityReader,
  ) {}

  private async join(
    roomId: Uuid,
    userId: Uuid,
    meta: ClientMeta,
    predicate: ReturnType<typeof and>,
  ) {
    const { room, inserted } = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const [room] = await t.select().from(chatRoom).where(predicate).limit(1);
        if (!room) {
          throw new ChatRoomNotFoundError(roomId);
        }
        const [ban] = await t
          .select({ id: chatRoomBan.id })
          .from(chatRoomBan)
          .where(
            and(
              eq(chatRoomBan.roomId, roomId),
              eq(chatRoomBan.userId, userId),
              isNull(chatRoomBan.liftedAt),
              or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, new Date())),
            ),
          )
          .limit(1);
        if (ban) {
          throw new ChatRoomBannedError(roomId);
        }
        const inserted = await t
          .insert(chatRoomMember)
          .values({ roomId, userId })
          .onConflictDoNothing()
          .returning();
        return { room, inserted };
      }),
    );
    if (inserted.length > 0) {
      this.events.emit('chat.room.member.joined', {
        roomId,
        userId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    }
    return toRoom(room);
  }

  joinRoom({ userId, joinCode, ip, userAgent }: { userId: Uuid; joinCode: string } & ClientMeta) {
    return this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoom)
      .where(and(eq(chatRoom.joinCode, joinCode), isNull(chatRoom.deletedAt)))
      .limit(1)
      .then(([candidate]) => {
        if (!candidate) {
          throw new ChatRoomJoinCodeNotFoundError(joinCode);
        }
        return this.join(
          candidate.id,
          userId,
          { ip, userAgent },
          and(
            eq(chatRoom.id, candidate.id),
            eq(chatRoom.joinCode, joinCode),
            isNull(chatRoom.deletedAt),
          ),
        );
      });
  }

  joinPublicRoom({ roomId, userId, ip, userAgent }: { roomId: Uuid; userId: Uuid } & ClientMeta) {
    return this.join(
      roomId,
      userId,
      { ip, userAgent },
      and(eq(chatRoom.id, roomId), eq(chatRoom.isPublic, true), isNull(chatRoom.deletedAt)),
    );
  }

  adminJoinRoom({ roomId, userId, ip, userAgent }: { roomId: Uuid; userId: Uuid } & ClientMeta) {
    return this.join(
      roomId,
      userId,
      { ip, userAgent },
      and(eq(chatRoom.id, roomId), isNull(chatRoom.deletedAt)),
    );
  }

  async leaveRoom({ userId, roomId, ip, userAgent }: { userId: Uuid; roomId: Uuid } & ClientMeta) {
    const removed = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const [room] = await t
          .select({ id: chatRoom.id, isPublic: chatRoom.isPublic })
          .from(chatRoom)
          .where(and(eq(chatRoom.id, roomId), isNull(chatRoom.deletedAt)))
          .limit(1);
        if (!room) {
          throw new ChatRoomNotFoundError(roomId);
        }
        const [member] = await t
          .select({ role: chatRoomMember.role })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
          .limit(1);
        if (!room.isPublic && !member) {
          throw new ChatRoomNotMemberError(roomId);
        }
        if (member && (member.role === 'moderator' || member.role === 'owner')) {
          const [{ modCount }] = await t
            .select({ modCount: count() })
            .from(chatRoomMember)
            .where(
              and(eq(chatRoomMember.roomId, roomId), inArray(chatRoomMember.role, MODERATOR_ROLES)),
            );
          if (Number(modCount) <= 1) {
            throw new ChatRoomLastModeratorError();
          }
        }
        return t
          .delete(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
          .returning();
      }),
    );
    if (removed.length > 0) {
      this.events.emit('chat.room.member.left', {
        roomId,
        userId,
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }
    return { success: true } as const;
  }

  async removeMember({
    moderatorId,
    roomId,
    userId,
    reason = '',
    ip,
    userAgent,
  }: { moderatorId: Uuid; roomId: Uuid; userId: Uuid; reason?: string } & ClientMeta) {
    if (moderatorId === userId) {
      throw new ChatRoomSelfModerationError();
    }
    const removed = await this.drizzle.db.transaction(async (t) => {
      const [moderator] = await t
        .select({ role: chatRoomMember.role })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, moderatorId)))
        .limit(1);
      if (!moderator) {
        throw new ChatRoomNotMemberError(roomId);
      }
      if (moderator.role !== 'moderator' && moderator.role !== 'owner') {
        throw new ChatRoomNotModeratorError(roomId);
      }
      const [target] = await t
        .select({ role: chatRoomMember.role })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
        .limit(1);
      if (moderator.role !== 'owner' && target && target.role !== 'member') {
        throw new ChatRoomNotModeratorError(roomId);
      }
      const removed = await t
        .delete(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
        .returning();
      if (removed.length > 0) {
        await t.insert(chatRoomRemove).values({ roomId, userId, removedBy: moderatorId, reason });
      }
      return removed;
    });
    if (removed.length > 0) {
      await this.audit?.record({
        actorId: moderatorId,
        actorType: 'player',
        action: 'chat.room.member.removed',
        resourceType: 'chat_room_remove',
        resourceId: removed[0].id,
        after: { roomId, userId, reason },
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
      this.events.emit('chat.room.member.removed', {
        roomId,
        userId,
        removedBy: moderatorId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }
    if (removed.length > 0) {
      await this.transport?.revokeClientFromChannel?.(userId, chatChannel(roomId));
    }
    return { success: true } as const;
  }

  /**
   * Grants or revokes the `moderator` role on a room member. Owner-only: a moderator must not
   * be able to create peers, so the shared `assertModerator` guard is deliberately not used.
   * Idempotent - a target already at the requested role is a successful no-op. Zero moderators
   * is a valid end state, so the last revoke is never blocked.
   */
  async setMemberRole({
    actorId,
    roomId,
    userId,
    role,
    ip,
    userAgent,
  }: {
    actorId: Uuid;
    roomId: Uuid;
    userId: Uuid;
    role: ChatRoomAssignableRole;
  } & ClientMeta) {
    // Same lock leaveRoom takes, so a role write serializes against the last-moderator check.
    const changed = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const [room] = await t
          .select({ id: chatRoom.id })
          .from(chatRoom)
          .where(and(eq(chatRoom.id, roomId), isNull(chatRoom.deletedAt)))
          .limit(1);
        if (!room) {
          throw new ChatRoomNotFoundError(roomId);
        }
        const [actor] = await t
          .select({ role: chatRoomMember.role })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, actorId)))
          .limit(1);
        if (!actor) {
          throw new ChatRoomNotMemberError(roomId);
        }
        if (actor.role !== 'owner') {
          throw new ChatRoomNotModeratorError(roomId);
        }
        const [target] = await t
          .select({ role: chatRoomMember.role })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
          .limit(1);
        if (!target) {
          throw new ChatRoomNotMemberError(roomId);
        }
        if (actorId === userId) {
          throw new ChatRoomSelfModerationError();
        }
        if (target.role === 'owner') {
          throw new ChatRoomNotModeratorError(roomId);
        }
        if (target.role === role) {
          return false;
        }
        await t
          .update(chatRoomMember)
          .set({ role, roleAssignedAt: role === 'member' ? null : new Date() })
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
        return true;
      }),
    );
    if (changed) {
      this.events.emit('chat.room.member.role-changed', {
        roomId,
        userId,
        changedBy: actorId,
        role,
        // Actor's resolved playerId, matching the kicked/banned events the audit trail
        // already attributes this way.
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(actorId),
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }
    return { success: true } as const;
  }
}
