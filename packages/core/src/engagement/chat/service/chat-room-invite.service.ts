import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  DrizzleService,
  serializeRow,
  withAdvisoryXactLock,
  withAdvisoryXactLocks,
} from '@openora/core/server';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import {
  isPlayRefused,
  playerIdsOf,
  type Account,
  type AccountReader,
  type AccountReadOptions,
  type ClientMeta,
  type IdentityReader,
  type PlayEligibilityPort,
  type Uuid,
} from '@openora/core/contracts';
import {
  chatPlatformBan,
  chatRoom,
  chatRoomBan,
  chatRoomConfiguration,
  chatRoomInvite,
  chatRoomMember,
  chatUserBlock,
} from '../schema/index.js';
import { ROOM_INVITE_EXPIRY_DAYS, UNKNOWN_PLAYER_USERNAME } from '../contract/constants.js';
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

// Where each user stands towards an invite into the room; first match wins: member, banned,
// invited, available.
async function inviteStatuses(
  db: Db,
  roomId: Uuid,
  userIds: readonly Uuid[],
  now: Date,
): Promise<Map<Uuid, ChatRoomInviteCandidateStatus>> {
  if (userIds.length === 0) {
    return new Map();
  }
  const ids = [...userIds];
  const members = await db
    .select({ userId: chatRoomMember.userId })
    .from(chatRoomMember)
    .where(and(eq(chatRoomMember.roomId, roomId), inArray(chatRoomMember.userId, ids)));
  const bans = await db
    .select({ userId: chatRoomBan.userId })
    .from(chatRoomBan)
    .where(and(activeRoomBan(roomId, now), inArray(chatRoomBan.userId, ids)));
  const invites = await db
    .select({ userId: chatRoomInvite.inviteeId })
    .from(chatRoomInvite)
    .where(
      and(
        eq(chatRoomInvite.roomId, roomId),
        inArray(chatRoomInvite.inviteeId, ids),
        liveInvite(db, now),
      ),
    );
  const memberIds = new Set(members.map((row) => row.userId));
  const bannedIds = new Set(bans.map((row) => row.userId));
  const invitedIds = new Set(invites.map((row) => row.userId));
  return new Map(
    ids.map((id) => [
      id,
      memberIds.has(id)
        ? 'member'
        : bannedIds.has(id)
          ? 'banned'
          : invitedIds.has(id)
            ? 'invited'
            : 'available',
    ]),
  );
}

const isInvitablePlayer = (account: Account | undefined): account is Account =>
  account?.role === 'player' && account.player !== null;

// An excluded player neither sees nor accepts invites, and an invite to them is withheld.
const isExcluded = (account: Account | undefined) => !account || account.excluded;

export class ChatRoomInviteService {
  private readonly identityReader: Pick<IdentityReader, 'getPlayerIdByUserIdSafe'>;

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly accounts: AccountReader,
    private readonly membership: Pick<ChatRoomMembershipService, 'joinByInvite' | 'findMemberRoom'>,
    // When bound, an operator's own play rule (an overlay rebinding) also withholds invites.
    private readonly playEligibility?: PlayEligibilityPort,
  ) {
    this.identityReader = playerIdsOf(accounts);
  }

  private async isPlayRefused(userId: Uuid) {
    return this.playEligibility ? isPlayRefused(this.playEligibility, userId) : false;
  }

  private async invitingRoom(db: Db, actorId: Uuid, roomId: Uuid) {
    const [room] = await db
      .select({
        name: chatRoom.name,
        canInvite: sql<boolean>`coalesce(${invitingRole}, false)`,
        lockRoom: chatRoomConfiguration.lockRoom,
      })
      .from(chatRoom)
      .innerJoin(
        chatRoomMember,
        and(eq(chatRoomMember.roomId, chatRoom.id), eq(chatRoomMember.userId, actorId)),
      )
      .leftJoin(chatRoomConfiguration, eq(chatRoomConfiguration.roomId, chatRoom.id))
      .where(aliveInvitableRoom(roomId))
      .limit(1);
    return room ?? null;
  }

  // A non-member gets NOT_FOUND so a private room's existence is not revealed. Called outside
  // any transaction: the audit signal reads the caller's account.
  private async refuseInvite(
    actorId: Uuid,
    roomId: Uuid,
    action: InviteAction,
    meta: ClientMeta,
    roomExists: boolean,
  ): Promise<never> {
    await emitAccessRefused(this.accounts, this.events, {
      actorId,
      resource: INVITE_AUDIT_RESOURCE,
      action,
      ...meta,
    });
    throw roomExists ? new ChatRoomInviteForbiddenError(roomId) : new ChatRoomNotFoundError(roomId);
  }

  private async assertCanInvite(
    actorId: Uuid,
    roomId: Uuid,
    action: InviteAction,
    meta: ClientMeta,
  ) {
    const room = await this.invitingRoom(this.drizzle.db, actorId, roomId);
    if (!room?.canInvite) {
      return this.refuseInvite(actorId, roomId, action, meta, room !== null);
    }
  }

  private async isExcluded(userId: Uuid, options?: AccountReadOptions) {
    return (
      isExcluded((await this.accounts.getAccounts([userId], options)).get(userId)) ||
      (await this.isPlayRefused(userId))
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
    // Read uncached and before the transaction: an exclusion bites at once, and an unreachable
    // identity service refuses before any write.
    const accounts = await this.accounts.getAccounts([actorId, userId], { fresh: true });
    const target = accounts.get(userId);
    const playRefused = await this.isPlayRefused(userId);
    const banLocks = [chatPlatformBanLockKey(actorId), chatPlatformBanLockKey(userId)];
    const outcome = await this.drizzle.db.transaction((t) =>
      withAdvisoryXactLock(t, `chat-room:${roomId}`, () =>
        withAdvisoryXactLocks(
          t,
          banLocks,
          async () => {
            const now = new Date();
            const room = await this.invitingRoom(t, actorId, roomId);
            if (!room?.canInvite) {
              return { refused: true, roomExists: room !== null } as const;
            }
            if (room.lockRoom) {
              throw new ChatRoomLockedError(roomId);
            }
            if (await hasActivePlatformBan(t, actorId, roomId, now)) {
              throw new ChatRoomBannedError(roomId);
            }
            if (!isInvitablePlayer(target)) {
              throw new ChatRoomInviteeNotPlayerError(userId);
            }
            const status = (await inviteStatuses(t, roomId, [userId], now)).get(userId);
            if (status === 'member') {
              throw new ChatRoomInviteeAlreadyMemberError(userId);
            }
            if (status === 'banned') {
              throw new ChatRoomInviteeBannedError(userId);
            }
            if (status === 'invited') {
              throw new ChatRoomInvitePendingError(userId);
            }
            const withheld =
              isExcluded(target) ||
              playRefused ||
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
            return { refused: false, invite, roomName: room.name, lapsed } as const;
          },
          'shared',
        ),
      ),
    );
    if (outcome.refused) {
      return this.refuseInvite(actorId, roomId, 'create', { ip, userAgent }, outcome.roomExists);
    }
    const { invite, roomName, lapsed } = outcome;
    const inviterUsername = accounts.get(actorId)?.username ?? UNKNOWN_PLAYER_USERNAME;
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
        inviterUsername,
        roomName,
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
    await this.assertCanInvite(actorId, roomId, 'search', { ip, userAgent });
    const found = await this.accounts.searchPlayers({ query: q, excludeUserId: actorId, limit });
    const statuses = await inviteStatuses(
      this.drizzle.db,
      roomId,
      found.map((account) => account.userId),
      new Date(),
    );
    return found.map((account) => ({
      userId: account.userId,
      username: account.username,
      avatarUrl: account.avatarUrl,
      inviteStatus: statuses.get(account.userId) ?? 'available',
    }));
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
    await this.assertCanInvite(actorId, roomId, 'lookup', { ip, userAgent });
    const ids = [...new Set(userIds)];
    const accounts = await this.accounts.getAccounts(ids);
    const statuses = await inviteStatuses(
      this.drizzle.db,
      roomId,
      ids.filter((id) => isInvitablePlayer(accounts.get(id))),
      new Date(),
    );
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
    const inviters = await this.accounts.getAccounts(rows.map((row) => row.inviterId));
    return rows.map((row) =>
      serializeRow(
        { ...row, inviterUsername: inviters.get(row.inviterId)?.username ?? null },
        { dateFields: ['createdAt'] },
      ),
    );
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
    if (await this.isExcluded(userId, { fresh: true })) {
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
