import { and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  DrizzleService,
  withAdvisoryXactLock,
  serializeRow,
  createLogger,
} from '@openora/core/server';
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

/**
 * What `handleAccountClosed` did to one room, so the post-commit fan-out (events, realtime
 * signals) can be built outside the transaction that made it true.
 */
type OwnershipHandover =
  | { kind: 'transferred'; roomName: string; newOwnerId: Uuid }
  | {
      kind: 'scheduled';
      roomName: string;
      scheduledDeletionAt: Date;
      /** Members reachable by a notification - closed accounts are already filtered out. */
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
        // `removeMember` does not take this lock, so the row read above can be gone by now.
        // The update decides whether anything actually changed, not the read.
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

  /**
   * Best-effort role-change signal on the room channel: the role is already committed, and
   * failing here would report failure for a write that happened and that a retry would no-op.
   * Without it a client keeps rendering the stale badge until its roster cache expires.
   */
  private async signalRoleChange(roomId: Uuid, userId: Uuid, role: ChatRoomRole) {
    const payload: ChatMemberRoleChangedSignal = { roomId, userId, role };
    try {
      await this.transport?.signal?.(chatChannel(roomId), CHAT_MEMBER_ROLE_CHANGED_SIGNAL, payload);
    } catch (err: unknown) {
      logger.error({ err, roomId, userId }, 'chat role-change signal failed');
    }
  }

  /**
   * Hands a private room over when one of its members' accounts is closed, or starts the
   * room's countdown to deletion when no moderator can inherit it. The only writer of
   * `chatRoomMember.accountClosedAt` and `chatRoom.scheduledDeletionAt`.
   *
   * Both triggers - an admin closing the player (`player.account.closed`) and the auth user
   * being deactivated (`identity.user.deactivated`) - route here, and firing for the same
   * person twice is a no-op: stamping the member row is guarded on it still being null, and
   * only the run that wins that write does any of the work behind it.
   *
   * Public rooms are out of scope: they have no owner to inherit and no roster to strand.
   */
  async handleAccountClosed({ userId, closedAt }: { userId: Uuid; closedAt: Date }) {
    const rooms = await this.drizzle.db
      .select({ id: chatRoom.id })
      .from(chatRoomMember)
      .innerJoin(chatRoom, eq(chatRoom.id, chatRoomMember.roomId))
      .where(
        and(
          eq(chatRoomMember.userId, userId),
          isNull(chatRoomMember.accountClosedAt),
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

  /**
   * The transactional half of {@link handleAccountClosed}, for one room. Takes the same
   * advisory lock join/leave/setMemberRole take, so it serializes against a concurrent
   * promote or leave rather than racing one. Returns null when there was nothing to do.
   */
  private closeAccountInRoom(roomId: Uuid, userId: Uuid, closedAt: Date) {
    return this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        // The stamp is the idempotency guard for the whole handler: a row already marked
        // is a room a previous run already finished, so it is skipped outright.
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
          return null;
        }
        // A closed moderator or plain member just becomes a ghost row on the roster.
        // Only the owner leaving takes the room with them.
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
        // A dead account must never inherit the room: two owners closed in sequence would
        // otherwise hand it straight to the first one's ghost row. `joinedAt` breaks the
        // tie for rows a backfill left without an assignment stamp.
        const [successor] = await t
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
          )
          .limit(1);
        // Ownership is read two ways - `chatRoom.creatorId` gates room edit and delete,
        // `chatRoomMember.role` gates the moderation guards - so both move together or the
        // new owner ends up unable to administer the room they just inherited.
        const demoteClosedOwner = () =>
          t
            .update(chatRoomMember)
            .set({ role: 'member', roleAssignedAt: null })
            .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));

        if (successor) {
          await t
            .update(chatRoomMember)
            .set({ role: 'owner', roleAssignedAt: new Date() })
            .where(
              and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, successor.userId)),
            );
          await t
            .update(chatRoom)
            .set({ creatorId: successor.userId })
            .where(eq(chatRoom.id, roomId));
          await demoteClosedOwner();
          return {
            handover: {
              kind: 'transferred',
              roomName: room.name,
              newOwnerId: successor.userId,
            },
          } as const;
        }

        // `creatorId = null` is deliberate: `updatePrivateRoom` and `deletePrivateRoom` both
        // throw on a null creator, so for the countdown's duration the room is writable for
        // chat and frozen for administration - nobody can rename it or delete it early.
        // The `scheduledDeletionAt is null` guard is what makes the countdown immune to
        // member activity: once running it is never rewritten.
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
        // Who to notify, not who is on the roster: a closed account has no session and
        // cannot log in, so a "your room is closing" notification for it is unreadable by
        // anyone. This also covers the owner whose closure triggered all of this - their
        // row was stamped at the top of this transaction - so they are excluded here too,
        // not only by the fan-out's own guard. The rows themselves stay; only the audience
        // shrinks.
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

  /**
   * The post-commit half: everything here is best-effort and log-and-continue, because the
   * database writes it reports have already happened and cannot be rolled back by a failure
   * to announce them.
   */
  private async announceAccountClosed(
    roomId: Uuid,
    userId: Uuid,
    handover: OwnershipHandover | null,
  ) {
    // The account is gone, so cut it off the room channel rather than leaving a dead
    // subscriber attached - the same cleanup `removeMember` does.
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
