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
  serializeRow,
  withAdvisoryXactLock,
} from '@openora/core/server';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import type { ClientMeta, IdentityReader, Uuid } from '@openora/core/contracts';
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

const UNAVAILABLE_PLAYER_STATUSES = ['suspended', 'closed'] as const;

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
            invitingRole,
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

function activePlatformBan(roomId: Uuid, now: Date) {
  return and(
    isNull(chatPlatformBan.liftedAt),
    or(isNull(chatPlatformBan.expiresAt), gt(chatPlatformBan.expiresAt, now)),
    or(
      inArray(chatPlatformBan.scope, platformScopesFor('private')),
      and(eq(chatPlatformBan.scope, 'room'), eq(chatPlatformBan.roomId, roomId)),
    ),
  );
}

function activeBlock(blockerId: Uuid | typeof user.id, blockedId: Uuid) {
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

// Blocks, platform bans and account state only hide a player who would otherwise read as
// available; a member, room-banned or invited player keeps that status, so nothing leaks.
function visibleCandidate(db: Db, actorId: Uuid, roomId: Uuid, now: Date) {
  const knownToRoom = or(
    exists(
      db
        .select({ id: chatRoomMember.id })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, user.id))),
    ),
    exists(
      db
        .select({ id: chatRoomBan.id })
        .from(chatRoomBan)
        .where(and(activeRoomBan(roomId, now), eq(chatRoomBan.userId, user.id))),
    ),
    exists(
      db
        .select({ id: chatRoomInvite.id })
        .from(chatRoomInvite)
        .where(
          and(
            eq(chatRoomInvite.roomId, roomId),
            eq(chatRoomInvite.inviteeId, user.id),
            liveInvite(db, now),
          ),
        ),
    ),
  );
  const unmasked = and(
    notInArray(player.status, [...UNAVAILABLE_PLAYER_STATUSES]),
    notExists(
      db
        .select({ blockerId: chatUserBlock.blockerId })
        .from(chatUserBlock)
        .where(activeBlock(user.id, actorId)),
    ),
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
    private readonly membership: Pick<ChatRoomMembershipService, 'joinByInvite'>,
  ) {}

  // A non-member gets NOT_FOUND so a private room's existence is not revealed.
  private async assertCanInvite(db: Db, actorId: Uuid, roomId: Uuid) {
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
    if (!room) {
      throw new ChatRoomNotFoundError(roomId);
    }
    if (!room.canInvite) {
      throw new ChatRoomInviteForbiddenError(roomId);
    }
    return {
      name: room.name,
      inviterUsername: room.inviterUsername,
      lockRoom: room.lockRoom === true,
    };
  }

  private async statusesFor(
    db: Db,
    roomId: Uuid,
    userIds: Uuid[],
  ): Promise<Map<Uuid, ChatRoomInviteCandidateStatus>> {
    const now = new Date();
    const [members, roomBans, pending] = await Promise.all([
      db
        .select({ userId: chatRoomMember.userId })
        .from(chatRoomMember)
        .where(and(eq(chatRoomMember.roomId, roomId), inArray(chatRoomMember.userId, userIds))),
      db
        .select({ userId: chatRoomBan.userId })
        .from(chatRoomBan)
        .where(and(activeRoomBan(roomId, now), inArray(chatRoomBan.userId, userIds))),
      db
        .select({ userId: chatRoomInvite.inviteeId })
        .from(chatRoomInvite)
        .where(
          and(
            eq(chatRoomInvite.roomId, roomId),
            inArray(chatRoomInvite.inviteeId, userIds),
            liveInvite(db, now),
          ),
        ),
    ]);
    const memberIds = new Set(members.map((row) => row.userId));
    const bannedIds = new Set(roomBans.map((row) => row.userId));
    const invitedIds = new Set(pending.map((row) => row.userId));
    return new Map(
      userIds.map((id) => {
        if (memberIds.has(id)) {
          return [id, 'member'];
        }
        if (bannedIds.has(id)) {
          return [id, 'banned'];
        }
        return [id, invitedIds.has(id) ? 'invited' : 'available'];
      }),
    );
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
    const { invite, room } = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, async () => {
        const now = new Date();
        const room = await this.assertCanInvite(t, actorId, roomId);
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
          .select({ role: user.role, status: player.status })
          .from(user)
          .leftJoin(player, eq(player.userId, user.id))
          .where(eq(user.id, userId))
          .limit(1);
        if (!target || target.role !== 'player' || target.status === null) {
          throw new ChatRoomInviteeNotPlayerError(userId);
        }
        const status = (await this.statusesFor(t, roomId, [userId])).get(userId);
        if (status === 'member') {
          throw new ChatRoomInviteeAlreadyMemberError(userId);
        }
        if (status === 'banned') {
          throw new ChatRoomInviteeBannedError(userId);
        }
        if (status === 'invited') {
          throw new ChatRoomInvitePendingError(userId);
        }
        const [visible] = await t
          .select({ id: user.id })
          .from(user)
          .innerJoin(player, eq(player.userId, user.id))
          .where(and(eq(user.id, userId), visibleCandidate(t, actorId, roomId, now)))
          .limit(1);
        if (!visible) {
          throw new ChatRoomInviteeUnavailableError(userId);
        }
        // A lapsed invite still holds the one-pending slot in the partial unique index.
        await t
          .delete(chatRoomInvite)
          .where(
            and(
              eq(chatRoomInvite.roomId, roomId),
              eq(chatRoomInvite.inviteeId, userId),
              eq(chatRoomInvite.status, 'pending'),
            ),
          );
        const [invite] = await t
          .insert(chatRoomInvite)
          .values({ roomId, inviterId: actorId, inviteeId: userId })
          .returning();
        if (!invite) {
          throw new Error('chat room invite insert returned no row');
        }
        return { invite, room };
      }),
    );
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
  }: {
    actorId: Uuid;
    roomId: Uuid;
    q: string;
    limit: number;
  }): Promise<ChatRoomInviteCandidate[]> {
    const db = this.drizzle.db;
    await this.assertCanInvite(db, actorId, roomId);
    const rows = await db
      .select({ userId: user.id, username: user.username, avatarUrl: user.image })
      .from(user)
      .innerJoin(player, eq(player.userId, user.id))
      .where(
        and(
          ne(user.id, actorId),
          ilike(user.username, likeContains(q)),
          visibleCandidate(db, actorId, roomId, new Date()),
        ),
      )
      .orderBy(
        sql`case when ${user.username} ilike ${likePrefix(q)} then 0 else 1 end`,
        asc(user.username),
      )
      .limit(limit);
    if (rows.length === 0) {
      return [];
    }
    const statuses = await this.statusesFor(
      db,
      roomId,
      rows.map((row) => row.userId),
    );
    return rows.map((row) => ({ ...row, inviteStatus: statuses.get(row.userId) ?? 'available' }));
  }

  async getRoomInviteStatuses({
    actorId,
    roomId,
    userIds,
  }: {
    actorId: Uuid;
    roomId: Uuid;
    userIds: Uuid[];
  }): Promise<ChatRoomInviteLookup[]> {
    const db = this.drizzle.db;
    await this.assertCanInvite(db, actorId, roomId);
    const ids = [...new Set(userIds)];
    const [visible, statuses] = await Promise.all([
      db
        .select({ userId: user.id })
        .from(user)
        .innerJoin(player, eq(player.userId, user.id))
        .where(and(inArray(user.id, ids), visibleCandidate(db, actorId, roomId, new Date()))),
      this.statusesFor(db, roomId, ids),
    ]);
    const visibleIds = new Set(visible.map((row) => row.userId));
    return ids.map((id) => ({
      userId: id,
      inviteStatus: visibleIds.has(id) ? (statuses.get(id) ?? 'available') : 'unavailable',
    }));
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
      throw new ChatRoomInviteNotFoundError(inviteId);
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
