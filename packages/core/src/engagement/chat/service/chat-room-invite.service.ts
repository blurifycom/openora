import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNull,
  ne,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  DrizzleService,
  likeContains,
  likePrefix,
  mapConcurrent,
  serializeRow,
  withAdvisoryXactLock,
} from '@openora/core/server';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import type {
  ClientMeta,
  IdentityReader,
  PlayEligibilityPort,
  Uuid,
} from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  chatPlatformBan,
  chatRoom,
  chatRoomBan,
  chatRoomConfiguration,
  chatRoomInvite,
  chatRoomMember,
  chatUserBlock,
} from '../schema/index.js';
import { ROOM_INVITE_EXPIRY_DAYS } from '../contract/constants.js';
import type {
  ChatRoomInviteCandidate,
  ChatRoomInviteCandidateStatus,
  ChatRoomInviteLookup,
} from '../contract/index.js';
import { platformScopesFor } from '../moderation/index.js';
import {
  ChatRoomBannedError,
  ChatRoomLockedError,
  ChatRoomNotFoundError,
} from './errors/chat-moderation.errors.js';
import {
  ChatRoomInviteForbiddenError,
  ChatRoomInviteNotFoundError,
  ChatRoomInvitePendingError,
  ChatRoomInviteSelfError,
  ChatRoomInviteeAlreadyMemberError,
  ChatRoomInviteeBannedError,
  ChatRoomInviteeNotPlayerError,
  ChatRoomInviteeUnavailableError,
  ChatRoomInviterBlockedError,
} from './errors/chat-room-invite.errors.js';
import type { ChatRoomMembershipService } from './chat-room-membership.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const MY_INVITES_LIMIT = 100;

const UNAVAILABLE_PLAYER_STATUSES = ['self_excluded', 'suspended', 'closed'] as const;

const ELIGIBILITY_CHECK_CONCURRENCY = 8;

const INVITE_AUDIT_RESOURCE = 'chat.room_invite';

type InviteAction = 'create' | 'search' | 'lookup';

type Db = DrizzleDb | DrizzleTx;

const invitingRole = or(
  eq(chatRoomMember.role, 'owner'),
  and(eq(chatRoomMember.role, 'moderator'), eq(chatRoomConfiguration.moderatorInvite, true)),
);

// An invite lapses after the expiry window or once its inviter may no longer invite.
function liveInvite(db: Db, now: Date) {
  return and(
    eq(chatRoomInvite.status, 'pending'),
    gt(chatRoomInvite.createdAt, new Date(now.getTime() - ROOM_INVITE_EXPIRY_DAYS * DAY_MS)),
    exists(
      db
        .select({ id: chatRoomMember.id })
        .from(chatRoomMember)
        .leftJoin(chatRoomConfiguration, eq(chatRoomConfiguration.roomId, chatRoomMember.roomId))
        .where(
          and(
            eq(chatRoomMember.roomId, chatRoomInvite.roomId),
            eq(chatRoomMember.userId, chatRoomInvite.inviterId),
            isNull(chatRoomMember.accountClosedAt),
            invitingRole,
          ),
        ),
    ),
    notExists(
      db
        .select({ id: chatPlatformBan.id })
        .from(chatPlatformBan)
        .where(
          and(
            eq(chatPlatformBan.userId, chatRoomInvite.inviterId),
            activePlatformBan(chatRoomInvite.roomId, now),
          ),
        ),
    ),
  );
}

function activeRoomBan(roomId: Uuid, now: Date) {
  return and(
    eq(chatRoomBan.roomId, roomId),
    isNull(chatRoomBan.liftedAt),
    or(isNull(chatRoomBan.expiresAt), gt(chatRoomBan.expiresAt, now)),
  );
}

function activePlatformBan(roomId: Uuid | typeof chatRoomInvite.roomId, now: Date) {
  return and(
    isNull(chatPlatformBan.liftedAt),
    or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, now)),
    or(
      inArray(chatPlatformBan.scope, platformScopesFor('private')),
      and(eq(chatPlatformBan.scope, 'room'), eq(chatPlatformBan.roomId, roomId)),
    ),
    or(isNull(chatPlatformBan.roomId), eq(chatPlatformBan.roomId, roomId)),
  );
}

function activeBlock(blockerId: Uuid, blockedId: Uuid) {
  return and(
    eq(chatUserBlock.blockerId, blockerId),
    eq(chatUserBlock.blockedId, blockedId),
    isNull(chatUserBlock.removedAt),
  );
}

function aliveInvitableRoom(roomId: Uuid) {
  return and(
    eq(chatRoom.id, roomId),
    eq(chatRoom.isPublic, false),
    isNull(chatRoom.deletedAt),
    isNull(chatRoom.scheduledDeletionAt),
  );
}

function memberRow(db: Db, roomId: Uuid) {
  return db
    .select({ id: chatRoomMember.id })
    .from(chatRoomMember)
    .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, user.id)));
}

function roomBanRow(db: Db, roomId: Uuid, now: Date) {
  return db
    .select({ id: chatRoomBan.id })
    .from(chatRoomBan)
    .where(and(activeRoomBan(roomId, now), eq(chatRoomBan.userId, user.id)));
}

function liveInviteRow(db: Db, roomId: Uuid, now: Date) {
  return db
    .select({ id: chatRoomInvite.id })
    .from(chatRoomInvite)
    .where(
      and(
        eq(chatRoomInvite.roomId, roomId),
        eq(chatRoomInvite.inviteeId, user.id),
        liveInvite(db, now),
      ),
    );
}

function inviteStatus(db: Db, roomId: Uuid, now: Date) {
  return sql<ChatRoomInviteCandidateStatus>`case
    when ${exists(memberRow(db, roomId))} then 'member'
    when ${exists(roomBanRow(db, roomId, now))} then 'banned'
    when ${exists(liveInviteRow(db, roomId, now))} then 'invited'
    else 'available' end`;
}

// Platform bans and account state only hide a player who would otherwise read as
// available; a member, room-banned or invited player keeps that status, so nothing leaks.
function visibleCandidate(db: Db, roomId: Uuid, now: Date) {
  const knownToRoom = or(
    exists(memberRow(db, roomId)),
    exists(roomBanRow(db, roomId, now)),
    exists(liveInviteRow(db, roomId, now)),
  );
  const unmasked = and(
    notInArray(player.status, [...UNAVAILABLE_PLAYER_STATUSES]),
    notExists(
      db
        .select({ id: chatPlatformBan.id })
        .from(chatPlatformBan)
        .where(and(activePlatformBan(roomId, now), eq(chatPlatformBan.userId, user.id))),
    ),
  );
  return and(eq(user.role, 'player'), or(knownToRoom, unmasked));
}

export class ChatRoomInviteService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly identityReader: IdentityReader,
    private readonly membership: Pick<ChatRoomMembershipService, 'joinByInvite' | 'findMemberRoom'>,
    private readonly playEligibility?: PlayEligibilityPort,
  ) {}

  // A non-member gets NOT_FOUND so a private room's existence is not revealed.
  private async assertCanInvite(
    db: Db,
    actorId: Uuid,
    roomId: Uuid,
    action: InviteAction,
    meta: ClientMeta,
  ) {
    const [room] = await db
      .select({
        name: chatRoom.name,
        inviterUsername: user.username,
        canInvite: sql<boolean>`coalesce(${invitingRole}, false)`,
        lockRoom: chatRoomConfiguration.lockRoom,
      })
      .from(chatRoom)
      .innerJoin(
        chatRoomMember,
        and(eq(chatRoomMember.roomId, chatRoom.id), eq(chatRoomMember.userId, actorId)),
      )
      .innerJoin(user, eq(user.id, chatRoomMember.userId))
      .leftJoin(chatRoomConfiguration, eq(chatRoomConfiguration.roomId, chatRoom.id))
      .where(aliveInvitableRoom(roomId))
      .limit(1);
    if (!room?.canInvite) {
      await this.auditRefusal(db, actorId, action, meta);
      throw room ? new ChatRoomInviteForbiddenError(roomId) : new ChatRoomNotFoundError(roomId);
    }
    return {
      name: room.name,
      inviterUsername: room.inviterUsername,
      lockRoom: room.lockRoom === true,
    };
  }

  // This check rejects before any shared guard runs, so it owes the audit log AdminGuard's signal.
  private async auditRefusal(
    db: Db,
    actorId: Uuid,
    action: InviteAction,
    { ip, userAgent }: ClientMeta,
  ) {
    const [caller] = await db
      .select({ role: user.role, playerId: player.id })
      .from(user)
      .leftJoin(player, eq(player.userId, user.id))
      .where(eq(user.id, actorId))
      .limit(1);
    this.events.emit('identity.user.unauthorized_access', {
      userId: actorId,
      playerId: caller?.playerId ?? null,
      resource: INVITE_AUDIT_RESOURCE,
      action,
      ...(caller?.role ? { role: caller.role } : {}),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  private async restrictedAmong(userIds: Uuid[]) {
    const eligibility = this.playEligibility;
    if (!eligibility || userIds.length === 0) {
      return new Set<Uuid>();
    }
    const restricted = await mapConcurrent(userIds, ELIGIBILITY_CHECK_CONCURRENCY, (id) =>
      eligibility.isRestricted(id),
    );
    return new Set(userIds.filter((_, index) => restricted[index]));
  }

  async inviteToRoom({
    actorId,
    roomId,
    userId,
    ip,
    userAgent,
  }: { actorId: Uuid; roomId: Uuid; userId: Uuid } & ClientMeta) {
    if (actorId === userId) {
      throw new ChatRoomInviteSelfError();
    }
    const { invite, room, lapsed } = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const now = new Date();
        const room = await this.assertCanInvite(t, actorId, roomId, 'create', { ip, userAgent });
        if (room.lockRoom) {
          throw new ChatRoomLockedError(roomId);
        }
        const [inviterBan] = await t
          .select({ id: chatPlatformBan.id })
          .from(chatPlatformBan)
          .where(and(eq(chatPlatformBan.userId, actorId), activePlatformBan(roomId, now)))
          .limit(1);
        if (inviterBan) {
          throw new ChatRoomBannedError(roomId);
        }
        const [target] = await t
          .select({
            role: user.role,
            status: player.status,
            inviteStatus: inviteStatus(t, roomId, now),
            visible: sql<boolean>`coalesce(${visibleCandidate(t, roomId, now)}, false)`,
          })
          .from(user)
          .leftJoin(player, eq(player.userId, user.id))
          .where(eq(user.id, userId))
          .limit(1);
        if (!target || target.role !== 'player' || target.status === null) {
          throw new ChatRoomInviteeNotPlayerError(userId);
        }
        if (target.inviteStatus === 'member') {
          throw new ChatRoomInviteeAlreadyMemberError(userId);
        }
        if (target.inviteStatus === 'banned') {
          throw new ChatRoomInviteeBannedError(userId);
        }
        if (target.inviteStatus === 'invited') {
          throw new ChatRoomInvitePendingError(userId);
        }
        const [block] = await t
          .select({ blockerId: chatUserBlock.blockerId })
          .from(chatUserBlock)
          .where(activeBlock(userId, actorId))
          .limit(1);
        if (!target.visible || block || (await this.restrictedAmong([userId])).size > 0) {
          throw new ChatRoomInviteeUnavailableError(userId);
        }
        // A lapsed invite still holds the one-pending slot in the partial unique index.
        const lapsed = await t
          .update(chatRoomInvite)
          .set({ status: 'expired' })
          .where(
            and(
              eq(chatRoomInvite.roomId, roomId),
              eq(chatRoomInvite.inviteeId, userId),
              eq(chatRoomInvite.status, 'pending'),
            ),
          )
          .returning({ id: chatRoomInvite.id, inviterId: chatRoomInvite.inviterId });
        const [invite] = await t
          .insert(chatRoomInvite)
          .values({ roomId, inviterId: actorId, inviteeId: userId })
          .returning();
        if (!invite) {
          throw new Error('chat room invite insert returned no row');
        }
        return { invite, room, lapsed };
      }),
    );
    for (const expired of lapsed) {
      this.events.emit('chat.room.invite.expired', {
        inviteId: expired.id,
        roomId,
        inviterId: expired.inviterId,
        inviteeId: userId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
    }
    this.events.emit('chat.room.invite.sent', {
      inviteId: invite.id,
      roomId,
      inviterId: actorId,
      inviteeId: userId,
      inviterUsername: room.inviterUsername,
      roomName: room.name,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(actorId),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return serializeRow(invite, { dateFields: ['createdAt', 'respondedAt'] });
  }

  async searchRoomInviteCandidates({
    actorId,
    roomId,
    q,
    limit,
    ip,
    userAgent,
  }: {
    actorId: Uuid;
    roomId: Uuid;
    q: string;
    limit: number;
  } & ClientMeta): Promise<ChatRoomInviteCandidate[]> {
    const db = this.drizzle.db;
    await this.assertCanInvite(db, actorId, roomId, 'search', { ip, userAgent });
    const now = new Date();
    const rows = await db
      .select({
        userId: user.id,
        username: user.username,
        avatarUrl: user.image,
        inviteStatus: inviteStatus(db, roomId, now),
      })
      .from(user)
      .innerJoin(player, eq(player.userId, user.id))
      .where(
        and(
          ne(user.id, actorId),
          ilike(user.username, likeContains(q)),
          visibleCandidate(db, roomId, now),
        ),
      )
      .orderBy(
        sql`case when ${user.username} ilike ${likePrefix(q)} then 0 else 1 end`,
        asc(user.username),
      )
      .limit(limit);
    const restricted = await this.restrictedAmong(
      rows.filter((row) => row.inviteStatus === 'available').map((row) => row.userId),
    );
    return rows.filter((row) => !restricted.has(row.userId));
  }

  async getRoomInviteStatuses({
    actorId,
    roomId,
    userIds,
    ip,
    userAgent,
  }: {
    actorId: Uuid;
    roomId: Uuid;
    userIds: Uuid[];
  } & ClientMeta): Promise<ChatRoomInviteLookup[]> {
    const db = this.drizzle.db;
    await this.assertCanInvite(db, actorId, roomId, 'lookup', { ip, userAgent });
    const ids = [...new Set(userIds)];
    const now = new Date();
    const rows = await db
      .select({ userId: user.id, inviteStatus: inviteStatus(db, roomId, now) })
      .from(user)
      .innerJoin(player, eq(player.userId, user.id))
      .where(and(inArray(user.id, ids), visibleCandidate(db, roomId, now)));
    const restricted = await this.restrictedAmong(
      rows.filter((row) => row.inviteStatus === 'available').map((row) => row.userId),
    );
    const statuses = new Map(
      rows
        .filter((row) => !restricted.has(row.userId))
        .map((row) => [row.userId, row.inviteStatus]),
    );
    return ids.map((id) => ({ userId: id, inviteStatus: statuses.get(id) ?? 'unavailable' }));
  }

  async listMyRoomInvites(userId: Uuid) {
    const db = this.drizzle.db;
    const rows = await db
      .select({
        id: chatRoomInvite.id,
        roomId: chatRoomInvite.roomId,
        roomName: chatRoom.name,
        inviterId: chatRoomInvite.inviterId,
        inviterUsername: user.username,
        createdAt: chatRoomInvite.createdAt,
      })
      .from(chatRoomInvite)
      .innerJoin(
        chatRoom,
        and(
          eq(chatRoom.id, chatRoomInvite.roomId),
          eq(chatRoom.isPublic, false),
          isNull(chatRoom.deletedAt),
          isNull(chatRoom.scheduledDeletionAt),
        ),
      )
      .leftJoin(user, eq(user.id, chatRoomInvite.inviterId))
      .where(
        and(
          eq(chatRoomInvite.inviteeId, userId),
          liveInvite(db, new Date()),
          notExists(
            db
              .select({ id: chatRoomMember.id })
              .from(chatRoomMember)
              .where(
                and(
                  eq(chatRoomMember.roomId, chatRoomInvite.roomId),
                  eq(chatRoomMember.userId, userId),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(chatRoomInvite.createdAt))
      .limit(MY_INVITES_LIMIT);
    return rows.map((row) => serializeRow(row, { dateFields: ['createdAt'] }));
  }

  async acceptRoomInvite({
    userId,
    inviteId,
    ip,
    userAgent,
  }: { userId: Uuid; inviteId: Uuid } & ClientMeta) {
    const addressedToCaller = (db: Db, now: Date) =>
      and(
        eq(chatRoomInvite.id, inviteId),
        eq(chatRoomInvite.inviteeId, userId),
        liveInvite(db, now),
      );
    const [invite] = await this.drizzle.db
      .select({ roomId: chatRoomInvite.roomId, inviterId: chatRoomInvite.inviterId })
      .from(chatRoomInvite)
      .where(addressedToCaller(this.drizzle.db, new Date()))
      .limit(1);
    if (!invite) {
      const room = await this.acceptedRoom(userId, inviteId);
      if (!room) {
        throw new ChatRoomInviteNotFoundError(inviteId);
      }
      return room;
    }
    const room = await this.membership.joinByInvite({
      roomId: invite.roomId,
      userId,
      ip,
      userAgent,
      inTransaction: async (t) => {
        const now = new Date();
        const [locked] = await t
          .select({ id: chatRoomInvite.id })
          .from(chatRoomInvite)
          .where(addressedToCaller(t, now))
          .for('update', { of: chatRoomInvite })
          .limit(1);
        if (!locked) {
          throw new ChatRoomInviteNotFoundError(inviteId);
        }
        const [platformBan] = await t
          .select({ id: chatPlatformBan.id })
          .from(chatPlatformBan)
          .where(and(eq(chatPlatformBan.userId, userId), activePlatformBan(invite.roomId, now)))
          .limit(1);
        if (platformBan) {
          throw new ChatRoomBannedError(invite.roomId);
        }
        const [block] = await t
          .select({ blockerId: chatUserBlock.blockerId })
          .from(chatUserBlock)
          .where(activeBlock(userId, invite.inviterId))
          .limit(1);
        if (block) {
          throw new ChatRoomInviterBlockedError();
        }
        await t
          .update(chatRoomInvite)
          .set({ status: 'accepted', respondedAt: now })
          .where(eq(chatRoomInvite.id, inviteId));
      },
    });
    this.events.emit('chat.room.invite.accepted', {
      inviteId,
      roomId: invite.roomId,
      inviterId: invite.inviterId,
      inviteeId: userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return room;
  }

  // A retried accept returns the room it already joined, while the invitee is still in it.
  private async acceptedRoom(userId: Uuid, inviteId: Uuid) {
    const [accepted] = await this.drizzle.db
      .select({ roomId: chatRoomInvite.roomId })
      .from(chatRoomInvite)
      .where(
        and(
          eq(chatRoomInvite.id, inviteId),
          eq(chatRoomInvite.inviteeId, userId),
          eq(chatRoomInvite.status, 'accepted'),
        ),
      )
      .limit(1);
    return accepted ? this.membership.findMemberRoom(accepted.roomId, userId) : null;
  }

  async declineRoomInvite({
    userId,
    inviteId,
    ip,
    userAgent,
  }: { userId: Uuid; inviteId: Uuid } & ClientMeta) {
    const db = this.drizzle.db;
    const now = new Date();
    const [declined] = await db
      .update(chatRoomInvite)
      .set({ status: 'declined', respondedAt: now })
      .where(
        and(
          eq(chatRoomInvite.id, inviteId),
          eq(chatRoomInvite.inviteeId, userId),
          liveInvite(db, now),
        ),
      )
      .returning({ roomId: chatRoomInvite.roomId, inviterId: chatRoomInvite.inviterId });
    if (!declined) {
      throw new ChatRoomInviteNotFoundError(inviteId);
    }
    this.events.emit('chat.room.invite.declined', {
      inviteId,
      roomId: declined.roomId,
      inviterId: declined.inviterId,
      inviteeId: userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { success: true } as const;
  }
}
