import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  DrizzleService,
  withAdvisoryXactLock,
  serializeRow,
  createLogger,
} from '@openora/core/server';
import type { DrizzleTx, EventBus } from '@openora/core/server';
import {
  chatChannel,
  type AuditWritePort,
  type ClientMeta,
  type IdentityReader,
  type RealtimeTransport,
  type Uuid,
} from '@openora/core/contracts';
import { chatRoom, chatRoomBan, chatRoomMember, chatRoomRemove } from '../schema/index.js';
import type {
  ChatMemberRoleChangedSignal,
  ChatRoomAssignableRole,
  ChatRoomRole,
  ChatRoomScheduledForDeletionSignal,
} from '../contract/index.js';
import {
  CHAT_MEMBER_ROLE_CHANGED_SIGNAL,
  CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL,
  OWNERLESS_ROOM_RETENTION_DAYS,
} from '../contract/constants.js';
import {
  ChatRoomBannedError,
  ChatRoomJoinCodeNotFoundError,
  ChatRoomLastModeratorError,
  ChatRoomNotFoundError,
  ChatRoomNotMemberError,
  ChatRoomNotModeratorError,
  ChatRoomOwnerCannotLeaveError,
  ChatRoomSelfModerationError,
} from './errors/chat-moderation.errors.js';

const MODERATOR_ROLES = ['moderator', 'owner'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const logger = createLogger('chat');

type OwnershipHandover =
  | { kind: 'transferred'; roomName: string; newOwnerId: Uuid }
  | {
      kind: 'scheduled';
      roomName: string;
      scheduledDeletionAt: Date;
      memberIds: Uuid[];
    };

function toRoom(record: typeof chatRoom.$inferSelect) {
  const { deletedAt: _deletedAt, ...room } = record;
  return serializeRow(
    { ...room, isBanned: false, bannedUntil: null },
    { dateFields: ['createdAt', 'bannedUntil', 'scheduledDeletionAt'] },
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
        // The owner is the only member who can manage or delete the room, and `creatorId`
        // keeps pointing at them once their membership row is gone - so letting them walk
        // out strands the room with no one able to administer it. Promoting a moderator
        // raises the count below past 1, which is exactly what used to make this reachable.
        if (member?.role === 'owner') {
          throw new ChatRoomOwnerCannotLeaveError();
        }
        // An owner can no longer be here, so this is the moderator case alone. The count
        // still spans both roles: what must not drop to zero is anyone able to moderate.
        if (member?.role === 'moderator') {
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
    const removed = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
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
      }),
    );
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
      await this.transport?.revokeUserFromChannel?.(userId, chatChannel(roomId));
    }
    return { success: true } as const;
  }

  /**
   * Grants or revokes the `moderator` role on a private room's member. Owner-only: a moderator
   * must not be able to create peers, so the shared `assertModerator` guard is deliberately not
   * used. Idempotent - a target already at the requested role is a successful no-op. Zero
   * moderators is a valid end state, so the last revoke is never blocked.
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
          .where(
            and(eq(chatRoom.id, roomId), eq(chatRoom.isPublic, false), isNull(chatRoom.deletedAt)),
          )
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
          return null;
        }
        const updated = await t
          .update(chatRoomMember)
          .set({ role, roleAssignedAt: role === 'member' ? null : new Date() })
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
          .returning({ id: chatRoomMember.id });
        return updated.length === 1 ? target.role : null;
      }),
    );
    if (changed) {
      this.events.emit('chat.room.member.role-changed', {
        roomId,
        userId,
        changedBy: actorId,
        role,
        previousRole: changed,
        // Null when the acting owner has no player record (the audit mapper then falls back
        // to `changedBy`), matching how the kicked/banned events carry the actor.
        playerId: await this.identityReader.getPlayerIdByUserIdSafe(actorId),
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
      // The EventBus is server-side only, so without this the promoted member keeps
      // rendering as a plain one until their roster cache happens to expire. Best-effort:
      // the role is already committed, and failing the call here would report failure for
      // a write that happened and that a retry would no-op.
      await this.signalRoleChange(roomId, userId, role);
    }
    return { success: true } as const;
  }

  private async signalRoleChange(roomId: Uuid, userId: Uuid, role: ChatRoomRole) {
    const payload: ChatMemberRoleChangedSignal = { roomId, userId, role };
    try {
      await this.transport?.signal?.(chatChannel(roomId), CHAT_MEMBER_ROLE_CHANGED_SIGNAL, payload);
    } catch (err: unknown) {
      logger.error({ err, roomId, userId }, 'chat role-change signal failed');
    }
  }

  async handleAccountClosed({ userId, closedAt }: { userId: Uuid; closedAt: Date }) {
    const rooms = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoomMember)
      .innerJoin(chatRoom, eq(chatRoom.id, chatRoomMember.roomId))
      .where(
        and(
          eq(chatRoomMember.userId, userId),
          eq(chatRoom.isPublic, false),
          isNull(chatRoom.deletedAt),
        ),
      );
    for (const { id: roomId } of rooms) {
      const result = await this.closeAccountInRoom(roomId, userId, closedAt);
      if (result) {
        await this.announceAccountClosed(roomId, userId, result.handover);
      }
    }
    return { success: true } as const;
  }

  private closeAccountInRoom(roomId: Uuid, userId: Uuid, closedAt: Date) {
    return this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const [stamped] = await t
          .update(chatRoomMember)
          .set({ accountClosedAt: closedAt })
          .where(
            and(
              eq(chatRoomMember.roomId, roomId),
              eq(chatRoomMember.userId, userId),
              isNull(chatRoomMember.accountClosedAt),
            ),
          )
          .returning({ role: chatRoomMember.role });
        if (!stamped) {
          return this.rederiveHandover(t, roomId, userId, closedAt);
        }
        if (stamped.role !== 'owner') {
          return { handover: null };
        }
        const [room] = await t
          .select({ name: chatRoom.name })
          .from(chatRoom)
          .where(
            and(eq(chatRoom.id, roomId), eq(chatRoom.isPublic, false), isNull(chatRoom.deletedAt)),
          )
          .limit(1);
        if (!room) {
          return { handover: null };
        }
        const candidates = await t
          .select({ userId: chatRoomMember.userId })
          .from(chatRoomMember)
          .where(
            and(
              eq(chatRoomMember.roomId, roomId),
              eq(chatRoomMember.role, 'moderator'),
              isNull(chatRoomMember.accountClosedAt),
            ),
          )
          .orderBy(
            sql`${chatRoomMember.roleAssignedAt} asc nulls last`,
            asc(chatRoomMember.joinedAt),
          );
        const demoteClosedOwner = () =>
          t
            .update(chatRoomMember)
            .set({ role: 'member', roleAssignedAt: null })
            .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));

        let newOwnerId: Uuid | null = null;
        for (const candidate of candidates) {
          const promoted = await t
            .update(chatRoomMember)
            .set({ role: 'owner', roleAssignedAt: closedAt })
            .where(
              and(
                eq(chatRoomMember.roomId, roomId),
                eq(chatRoomMember.userId, candidate.userId),
                isNull(chatRoomMember.accountClosedAt),
              ),
            )
            .returning({ id: chatRoomMember.id });
          if (promoted.length === 1) {
            newOwnerId = candidate.userId;
            break;
          }
        }

        if (newOwnerId) {
          await t.update(chatRoom).set({ creatorId: newOwnerId }).where(eq(chatRoom.id, roomId));
          await demoteClosedOwner();
          return {
            handover: {
              kind: 'transferred',
              roomName: room.name,
              newOwnerId,
            },
          } as const;
        }

        const [scheduled] = await t
          .update(chatRoom)
          .set({
            creatorId: null,
            scheduledDeletionAt: new Date(
              closedAt.getTime() + OWNERLESS_ROOM_RETENTION_DAYS * DAY_MS,
            ),
          })
          .where(and(eq(chatRoom.id, roomId), isNull(chatRoom.scheduledDeletionAt)))
          .returning({ scheduledDeletionAt: chatRoom.scheduledDeletionAt });
        await demoteClosedOwner();
        if (!scheduled?.scheduledDeletionAt) {
          return { handover: null };
        }
        const recipients = await t
          .select({ userId: chatRoomMember.userId })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), isNull(chatRoomMember.accountClosedAt)));
        return {
          handover: {
            kind: 'scheduled',
            roomName: room.name,
            scheduledDeletionAt: scheduled.scheduledDeletionAt,
            memberIds: recipients.map((m) => m.userId),
          },
        } as const;
      }),
    );
  }

  private async rederiveHandover(t: DrizzleTx, roomId: Uuid, userId: Uuid, closedAt: Date) {
    const [member] = await t
      .select({ accountClosedAt: chatRoomMember.accountClosedAt })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
      .limit(1);
    if (member?.accountClosedAt?.getTime() !== closedAt.getTime()) {
      return null;
    }
    const [room] = await t
      .select({
        name: chatRoom.name,
        creatorId: chatRoom.creatorId,
        scheduledDeletionAt: chatRoom.scheduledDeletionAt,
      })
      .from(chatRoom)
      .where(and(eq(chatRoom.id, roomId), eq(chatRoom.isPublic, false), isNull(chatRoom.deletedAt)))
      .limit(1);
    if (!room) {
      return null;
    }
    if (room.creatorId) {
      const [successor] = await t
        .select({ userId: chatRoomMember.userId })
        .from(chatRoomMember)
        .where(
          and(
            eq(chatRoomMember.roomId, roomId),
            eq(chatRoomMember.userId, room.creatorId),
            eq(chatRoomMember.role, 'owner'),
            eq(chatRoomMember.roleAssignedAt, closedAt),
            isNull(chatRoomMember.accountClosedAt),
          ),
        )
        .limit(1);
      if (!successor) {
        return null;
      }
      return {
        handover: { kind: 'transferred', roomName: room.name, newOwnerId: successor.userId },
      } as const;
    }
    if (
      room.scheduledDeletionAt?.getTime() !==
      closedAt.getTime() + OWNERLESS_ROOM_RETENTION_DAYS * DAY_MS
    ) {
      return null;
    }
    const recipients = await t
      .select({ userId: chatRoomMember.userId })
      .from(chatRoomMember)
      .where(and(eq(chatRoomMember.roomId, roomId), isNull(chatRoomMember.accountClosedAt)));
    return {
      handover: {
        kind: 'scheduled',
        roomName: room.name,
        scheduledDeletionAt: room.scheduledDeletionAt,
        memberIds: recipients.map((m) => m.userId),
      },
    } as const;
  }

  async handleAccountReopened({ userId }: { userId: Uuid }) {
    const rooms = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoomMember)
      .innerJoin(chatRoom, eq(chatRoom.id, chatRoomMember.roomId))
      .where(
        and(
          eq(chatRoomMember.userId, userId),
          isNotNull(chatRoomMember.accountClosedAt),
          eq(chatRoom.isPublic, false),
          isNull(chatRoom.deletedAt),
        ),
      );
    for (const { id: roomId } of rooms) {
      const restored = await this.reopenAccountInRoom(roomId, userId);
      if (restored) {
        await this.announceDeletionCancelled(roomId, userId, restored);
      }
    }
    return { success: true } as const;
  }

  private reopenAccountInRoom(roomId: Uuid, userId: Uuid) {
    return this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const [member] = await t
          .select({ accountClosedAt: chatRoomMember.accountClosedAt })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
          .limit(1);
        const cleared = await t
          .update(chatRoomMember)
          .set({ accountClosedAt: null })
          .where(
            and(
              eq(chatRoomMember.roomId, roomId),
              eq(chatRoomMember.userId, userId),
              isNotNull(chatRoomMember.accountClosedAt),
            ),
          )
          .returning({ id: chatRoomMember.id });
        const closedAt = member?.accountClosedAt;
        if (cleared.length !== 1 || !closedAt) {
          return null;
        }
        const [room] = await t
          .select({
            name: chatRoom.name,
            creatorId: chatRoom.creatorId,
            scheduledDeletionAt: chatRoom.scheduledDeletionAt,
          })
          .from(chatRoom)
          .where(eq(chatRoom.id, roomId))
          .limit(1);
        if (!room || room.creatorId || !room.scheduledDeletionAt) {
          return null;
        }
        if (
          room.scheduledDeletionAt.getTime() !==
          closedAt.getTime() + OWNERLESS_ROOM_RETENTION_DAYS * DAY_MS
        ) {
          return null;
        }
        const [uncancelled] = await t
          .update(chatRoom)
          .set({ creatorId: userId, scheduledDeletionAt: null })
          .where(and(eq(chatRoom.id, roomId), isNotNull(chatRoom.scheduledDeletionAt)))
          .returning({ id: chatRoom.id });
        if (!uncancelled) {
          return null;
        }
        await t
          .update(chatRoomMember)
          .set({ role: 'owner', roleAssignedAt: new Date() })
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));
        const recipients = await t
          .select({ userId: chatRoomMember.userId })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), isNull(chatRoomMember.accountClosedAt)));
        return { roomName: room.name, memberIds: recipients.map((m) => m.userId) };
      }),
    );
  }

  private async announceDeletionCancelled(
    roomId: Uuid,
    userId: Uuid,
    restored: { roomName: string; memberIds: Uuid[] },
  ) {
    this.events.emit('chat.room.deletion.cancelled', {
      roomId,
      roomName: restored.roomName,
      ownerId: userId,
      memberIds: restored.memberIds,
    });
    await this.signalRoleChange(roomId, userId, 'owner');
    const payload: ChatRoomScheduledForDeletionSignal = { roomId, scheduledDeletionAt: null };
    try {
      await this.transport?.signal?.(
        chatChannel(roomId),
        CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL,
        payload,
      );
    } catch (err: unknown) {
      logger.error({ err, roomId }, 'chat room deletion-cancelled signal failed');
    }
  }

  private async announceAccountClosed(
    roomId: Uuid,
    userId: Uuid,
    handover: OwnershipHandover | null,
  ) {
    try {
      await this.transport?.revokeUserFromChannel?.(userId, chatChannel(roomId));
    } catch (err: unknown) {
      logger.error({ err, roomId, userId }, 'chat room channel revoke failed');
    }
    if (!handover) {
      return;
    }
    if (handover.kind === 'transferred') {
      this.events.emit('chat.room.ownership.transferred', {
        roomId,
        roomName: handover.roomName,
        previousOwnerId: userId,
        newOwnerId: handover.newOwnerId,
        reason: 'account-closed',
      });
      await this.signalRoleChange(roomId, handover.newOwnerId, 'owner');
      await this.signalRoleChange(roomId, userId, 'member');
      return;
    }
    this.events.emit('chat.room.scheduled_for_deletion', {
      roomId,
      roomName: handover.roomName,
      previousOwnerId: userId,
      memberIds: handover.memberIds,
      scheduledDeletionAt: handover.scheduledDeletionAt.toISOString(),
    });
    await this.signalRoleChange(roomId, userId, 'member');
    const payload: ChatRoomScheduledForDeletionSignal = {
      roomId,
      scheduledDeletionAt: handover.scheduledDeletionAt.toISOString(),
    };
    try {
      await this.transport?.signal?.(
        chatChannel(roomId),
        CHAT_ROOM_SCHEDULED_FOR_DELETION_SIGNAL,
        payload,
      );
    } catch (err: unknown) {
      logger.error({ err, roomId }, 'chat room scheduled-for-deletion signal failed');
    }
  }
}
