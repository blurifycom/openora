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
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  DrizzleService,
  likeContains,
  likePrefix,
  serializeRow,
  withAdvisoryXactLock,
  withAdvisoryXactLocks,
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
  ChatRoomInviterBlockedError,
} from './errors/chat-room-invite.errors.js';
import type { ChatRoomMembershipService } from './chat-room-membership.service.js';
import { chatPlatformBanLockKey } from './chat-ban.service.js';
import { emitAccessRefused } from './chat-access-refusal.service.js';
import {
  emitExpiredInvites,
  expirePendingInvites,
  type ExpiredInvite,
} from './chat-room-invite-expiry.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const MY_INVITES_LIMIT = 100;

const EXCLUDED_PLAYER_STATUSES = ['self_excluded', 'suspended', 'closed'] as const;

const INVITE_EXPIRY_BATCH_SIZE = 500;

const INVITE_AUDIT_RESOURCE = 'chat.room_invite';

type InviteAction = 'create' | 'search' | 'lookup';

type Db = DrizzleDb | DrizzleTx;

const invitingRole = or(
  eq(chatRoomMember.role, 'owner'),
  and(eq(chatRoomMember.role, 'moderator'), eq(chatRoomConfiguration.moderatorInvite, true)),
);

// An invite lapses after the expiry window, once its room closes, or once its inviter may no longer invite.
function liveInvite(db: Db, now: Date) {
  return and(
    eq(chatRoomInvite.status, 'pending'),
    gt(chatRoomInvite.createdAt, new Date(now.getTime() - ROOM_INVITE_EXPIRY_DAYS * DAY_MS)),
    exists(
      db
        .select({ id: chatRoom.id })
        .from(chatRoom)
        .where(aliveInvitableRoom(chatRoomInvite.roomId)),
    ),
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

function deliverableInvite(db: Db, now: Date) {
  return and(liveInvite(db, now), eq(chatRoomInvite.withheld, false));
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

async function hasActivePlatformBan(db: Db, userId: Uuid, roomId: Uuid, now: Date) {
  const [ban] = await db
    .select({ id: chatPlatformBan.id })
    .from(chatPlatformBan)
    .where(and(eq(chatPlatformBan.userId, userId), activePlatformBan(roomId, now)))
    .limit(1);
  return ban !== undefined;
}

async function hasActiveBlock(db: Db, blockerId: Uuid, blockedId: Uuid) {
  const [block] = await db
    .select({ blockerId: chatUserBlock.blockerId })
    .from(chatUserBlock)
    .where(activeBlock(blockerId, blockedId))
    .limit(1);
  return block !== undefined;
}

function aliveInvitableRoom(roomId: Uuid | typeof chatRoomInvite.roomId) {
  return and(
    eq(chatRoom.id, roomId),
    eq(chatRoom.isPublic, false),
    isNull(chatRoom.deletedAt),
    isNull(chatRoom.scheduledDeletionAt),
  );
}

function inviteStatus(db: Db, roomId: Uuid, now: Date) {
  const member = db
    .select({ id: chatRoomMember.id })
    .from(chatRoomMember)
    .where(and(eq(chatRoomMember.roomId, roomId), eq(chatRoomMember.userId, user.id)));
  const roomBan = db
    .select({ id: chatRoomBan.id })
    .from(chatRoomBan)
    .where(and(activeRoomBan(roomId, now), eq(chatRoomBan.userId, user.id)));
  const pendingInvite = db
    .select({ id: chatRoomInvite.id })
    .from(chatRoomInvite)
    .where(
      and(
        eq(chatRoomInvite.roomId, roomId),
        eq(chatRoomInvite.inviteeId, user.id),
        liveInvite(db, now),
      ),
    );
  return sql<ChatRoomInviteCandidateStatus>`case
    when ${exists(member)} then 'member'
    when ${exists(roomBan)} then 'banned'
    when ${exists(pendingInvite)} then 'invited'
    else 'available' end`;
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
      await emitAccessRefused(db, this.events, {
        actorId,
        resource: INVITE_AUDIT_RESOURCE,
        action,
        ...meta,
      });
      throw room ? new ChatRoomInviteForbiddenError(roomId) : new ChatRoomNotFoundError(roomId);
    }
    return {
      name: room.name,
      inviterUsername: room.inviterUsername,
      lockRoom: room.lockRoom === true,
    };
  }

  private async isRestricted(userId: Uuid) {
    return (await this.playEligibility?.isRestricted(userId)) ?? false;
  }

  private async isExcluded(userId: Uuid) {
    if (await this.isRestricted(userId)) {
      return true;
    }
    const [row] = await this.drizzle.db
      .select({ status: player.status })
      .from(player)
      .where(eq(player.userId, userId))
      .limit(1);
    return EXCLUDED_PLAYER_STATUSES.some((status) => status === row?.status);
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
    const restricted = await this.isRestricted(userId);
    const banLocks = [chatPlatformBanLockKey(actorId), chatPlatformBanLockKey(userId)];
    const { invite, room, lapsed } = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, () =>
        withAdvisoryXactLocks(
          t,
          banLocks,
          async () => {
            const now = new Date();
            const room = await this.assertCanInvite(t, actorId, roomId, 'create', {
              ip,
              userAgent,
            });
            if (room.lockRoom) {
              throw new ChatRoomLockedError(roomId);
            }
            if (await hasActivePlatformBan(t, actorId, roomId, now)) {
              throw new ChatRoomBannedError(roomId);
            }
            const [target] = await t
              .select({
                role: user.role,
                status: player.status,
                inviteStatus: inviteStatus(t, roomId, now),
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
            const withheld =
              restricted ||
              EXCLUDED_PLAYER_STATUSES.some((status) => status === target.status) ||
              (await hasActivePlatformBan(t, userId, roomId, now)) ||
              (await hasActiveBlock(t, userId, actorId));
            // A lapsed invite still holds the one-pending slot in the partial unique index.
            const lapsed = await expirePendingInvites(
              t,
              and(eq(chatRoomInvite.roomId, roomId), eq(chatRoomInvite.inviteeId, userId)),
            );
            const [invite] = await t
              .insert(chatRoomInvite)
              .values({ roomId, inviterId: actorId, inviteeId: userId, withheld })
              .returning();
            if (!invite) {
              throw new Error('chat room invite insert returned no row');
            }
            return { invite, room, lapsed };
          },
          'shared',
        ),
      ),
    );
    const playerId = await this.identityReader.getPlayerIdByUserIdSafe(actorId);
    emitExpiredInvites(this.events, lapsed, { actorId, actorPlayerId: playerId, ip, userAgent });
    const { withheld, ...sent } = invite;
    const recorded = {
      inviteId: invite.id,
      roomId,
      inviterId: actorId,
      inviteeId: userId,
      playerId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    };
    if (withheld) {
      this.events.emit('chat.room.invite.withheld', recorded);
    } else {
      this.events.emit('chat.room.invite.sent', {
        ...recorded,
        inviterUsername: room.inviterUsername,
        roomName: room.name,
      });
    }
    return serializeRow(sent, { dateFields: ['createdAt', 'respondedAt'] });
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
    return db
      .select({
        userId: user.id,
        username: user.username,
        avatarUrl: user.image,
        inviteStatus: inviteStatus(db, roomId, now),
      })
      .from(user)
      .innerJoin(player, eq(player.userId, user.id))
      .where(
        and(ne(user.id, actorId), ilike(user.username, likeContains(q)), eq(user.role, 'player')),
      )
      .orderBy(
        sql`case when ${user.username} ilike ${likePrefix(q)} then 0 else 1 end`,
        asc(user.username),
      )
      .limit(limit);
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
      .where(and(inArray(user.id, ids), eq(user.role, 'player')));
    const statuses = new Map(rows.map((row) => [row.userId, row.inviteStatus]));
    return ids.map((id) => ({ userId: id, inviteStatus: statuses.get(id) ?? 'unavailable' }));
  }

  async listMyRoomInvites(userId: Uuid) {
    if (await this.isExcluded(userId)) {
      return [];
    }
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
          deliverableInvite(db, new Date()),
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
        deliverableInvite(db, now),
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
    if (await this.isExcluded(userId)) {
      throw new ChatRoomInviteNotFoundError(inviteId);
    }
    const room = await this.joinByInvite(userId, inviteId, invite, addressedToCaller, {
      ip,
      userAgent,
    });
    if (!room.accepted) {
      return room.room;
    }
    this.events.emit('chat.room.invite.accepted', {
      inviteId,
      roomId: invite.roomId,
      inviterId: invite.inviterId,
      inviteeId: userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return room.room;
  }

  // A concurrent accept of the same invite finds it already accepted once it gets the room lock.
  private async joinByInvite(
    userId: Uuid,
    inviteId: Uuid,
    invite: { roomId: Uuid; inviterId: Uuid },
    addressedToCaller: (db: Db, now: Date) => SQL | undefined,
    meta: ClientMeta,
  ) {
    try {
      const room = await this.membership.joinByInvite({
        roomId: invite.roomId,
        userId,
        ...meta,
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
          if (await hasActivePlatformBan(t, userId, invite.roomId, now)) {
            throw new ChatRoomBannedError(invite.roomId);
          }
          if (await hasActiveBlock(t, userId, invite.inviterId)) {
            throw new ChatRoomInviterBlockedError();
          }
          await t
            .update(chatRoomInvite)
            .set({ status: 'accepted', respondedAt: now })
            .where(eq(chatRoomInvite.id, inviteId));
        },
      });
      return { room, accepted: true } as const;
    } catch (err) {
      if (!(err instanceof ChatRoomInviteNotFoundError)) {
        throw err;
      }
      const room = await this.acceptedRoom(userId, inviteId);
      if (!room) {
        throw err;
      }
      return { room, accepted: false } as const;
    }
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
          deliverableInvite(db, now),
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

  async expireLapsedInvites() {
    const db = this.drizzle.db;
    let expired = 0;
    let batch: ExpiredInvite[];
    do {
      batch = await expirePendingInvites(
        db,
        inArray(
          chatRoomInvite.id,
          db
            .select({ id: chatRoomInvite.id })
            .from(chatRoomInvite)
            .where(
              and(eq(chatRoomInvite.status, 'pending'), sql`not (${liveInvite(db, new Date())})`),
            )
            .limit(INVITE_EXPIRY_BATCH_SIZE),
        ),
      );
      emitExpiredInvites(this.events, batch);
      expired += batch.length;
    } while (batch.length === INVITE_EXPIRY_BATCH_SIZE);
    return expired;
  }
}
