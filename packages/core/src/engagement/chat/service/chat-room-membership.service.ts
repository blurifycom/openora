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
    // Same lock the handover, join, leave and role writes take. Without it this delete lands
    // between `closeAccountInRoom` picking a successor and promoting them, and the room keeps a
    // `creatorId` who is no longer a member - no owner on the roster, no deletion deadline.
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
        // The update decides whether anything actually changed, not the read: the read is only
        // as good as the lock, and a row can still be gone if a future writer forgets to take it.
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
   * person twice writes nothing the second time: stamping the member row is guarded on it
   * still being null, and only the run that wins that write does any of the work behind it.
   *
   * The announce behind those writes is a different matter, and is deliberately NOT guarded
   * away. It happens after the transaction commits, so a redelivery is the only thing that
   * can replace an announce lost to a crash in between - see {@link rederiveHandover}. That
   * is why the room scan below does not filter on `accountClosedAt`.
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
        // The stamp is the write guard for the whole handler: a row already marked is a
        // room a previous run already changed, so nothing here writes twice. What that run
        // may not have finished is the announce, so losing this race hands over to the
        // re-derivation rather than returning.
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
        // Ownership is read two ways - `chatRoom.creatorId` gates room edit and delete,
        // `chatRoomMember.role` gates the moderation guards - so both move together or the
        // new owner ends up unable to administer the room they just inherited.
        const demoteClosedOwner = () =>
          t
            .update(chatRoomMember)
            .set({ role: 'member', roleAssignedAt: null })
            .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)));

        // `creatorId` follows a promotion that actually landed, never the row the select saw.
        // Every membership writer now takes the lock above, so a candidate disappearing between
        // the two is not reachable today - this is the guard that keeps it that way, and the
        // fallback when no candidate survives is the same countdown an ownerless room gets.
        let newOwnerId: Uuid | null = null;
        for (const candidate of candidates) {
          // `closedAt`, not `new Date()`: it ties the promotion to the closure that caused
          // it, which is what lets a redelivery recognise its own transfer (see
          // `rederiveHandover`). On a retry it is also the more honest timestamp - the
          // room changed hands when the account closed, not when the retry ran.
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
   * Rebuilds the announce for a room a previous delivery already wrote, so a crash between
   * that commit and its fan-out does not leave the room silently changed: without this a
   * redelivery short-circuits on the stamp, members never hear the room is closing, and the
   * purge still deletes it when the countdown runs out.
   *
   * Nothing here writes. It re-announces only what THIS closure caused, which both stamps
   * make provable: the member row carries `accountClosedAt = closedAt`, the countdown is
   * `closedAt + OWNERLESS_ROOM_RETENTION_DAYS`, and a successor promoted by this closure
   * carries `roleAssignedAt = closedAt`. A room changed by somebody else's closure matches
   * none of those and is left alone. `closedAt` comes off the job payload, so it is the
   * same value on every delivery of the same closure.
   */
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

  /**
   * The inverse of {@link handleAccountClosed}, for an account that came back - an admin
   * reactivated the auth user, or moved the player out of `closed`. Without it a closure is
   * one-way in a way neither trigger is: the member row stays stamped, so the player renders
   * as a deleted account on every roster forever and can never inherit a room again, and a
   * countdown their closure started keeps running until the purge hard-deletes the room and
   * its messages - a destructive outcome from an action the operator undid.
   *
   * Clearing the stamp is unconditional. Cancelling the countdown is not: it happens only
   * when the room is still owner-less AND its deadline is exactly the one this player's
   * closure wrote, which is the same three-stamp reasoning {@link rederiveHandover} uses. A
   * room a moderator inherited is left alone - the successor keeps it, matching the accepted
   * "a transfer is not reversible" behaviour. Idempotent: a row already clear does nothing.
   */
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

  /** The transactional half of {@link handleAccountReopened}, for one room. */
  private reopenAccountInRoom(roomId: Uuid, userId: Uuid) {
    return this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        // Read before the clear, because the closure instant is what decides whether the
        // countdown below is this player's to cancel, and `returning` on the clear would
        // hand back the new value.
        const [member] = await t
          .select({ accountClosedAt: chatRoomMember.accountClosedAt })
          .from(chatRoomMember)
          .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, userId)))
          .limit(1);
        // Clearing the stamp is the write guard, the same way setting it is on the way in:
        // only the run that wins it does the work behind it, so a redelivery is a no-op.
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
        // A room with a creator is one a moderator inherited, and the successor keeps it.
        // A deadline that is not `closedAt + OWNERLESS_ROOM_RETENTION_DAYS` belongs to a
        // different member's closure - this player was only a member of that room, and
        // handing it to them because they happened to come back first would be a silent
        // ownership grant. Same three-stamp reasoning `rederiveHandover` uses.
        if (!room || room.creatorId || !room.scheduledDeletionAt) {
          return null;
        }
        if (
          room.scheduledDeletionAt.getTime() !==
          closedAt.getTime() + OWNERLESS_ROOM_RETENTION_DAYS * DAY_MS
        ) {
          return null;
        }
        // Ownership moves back as a pair, exactly as the handover moved it: `creatorId`
        // gates room edit and delete, the member role gates the moderation guards.
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

  /**
   * Post-commit half of the cancellation. Best-effort like every other announce here: the
   * room is already off death row and no failure to say so can put it back on.
   */
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
    // Same signal name as the countdown, with a null deadline: a client that renders the
    // banner from this signal clears it from the same handler rather than needing a second
    // one, and one that refetches the room reads the same null off `scheduledDeletionAt`.
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
