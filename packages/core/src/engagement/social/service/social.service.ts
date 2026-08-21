import { and, count, desc, eq, inArray, isNotNull, isNull, or, SQL, sql } from 'drizzle-orm';
import {
  type DrizzleDb,
  type DrizzleService,
  type EventBus,
  createDomainError,
  createLogger,
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  serializeRow,
} from '@openora/core/server';
import {
  type FriendshipDissolvedPayload,
  type IdentityReader,
  type Uuid,
} from '@openora/core/contracts';
import { chatUserBlock, chatUserIgnore } from '@openora/core/engagement/schema/chat';
import { player } from '@openora/core/pam/schema/profile';
import { user } from '@openora/core/pam/schema/identity';
import { friendship } from '../schema/index.js';
import {
  type Friendship,
  type FriendListEntry,
  type FriendRequestDirection,
  type FriendRequestEntry,
  type Relationship,
} from '../contract/index.js';

const logger = createLogger('social');

const ONLINE_STATUS_WINDOW_MS = 3 * 60 * 1000;

type FriendshipRow = typeof friendship.$inferSelect;

// The caller targeted themselves (SendFriendRequestInputSchema.targetUserId === callerId).
export const SelfFriendRequestError = createDomainError(
  'SelfFriendRequestError',
  () => 'You cannot send a friend request to yourself',
);

// A genuinely nonexistent target only - never thrown for a target that exists but
// can't be requested (moderated or blocking), so an API consumer can trust that a
// NOT_FOUND means "no such player" and not have to guess.
export const FriendRequestTargetNotFoundError = makeNotFoundError('FriendRequestTarget');

// The target exists but can't receive requests right now - covers BOTH "suspended
// or closed" and "target has blocked the caller" behind the SAME code/message so
// callers still cannot distinguish a blocking account from a moderated one (the
// block itself stays undisclosed); this only stops lying that the account is
// missing entirely.
export const FriendRequestUnavailableError = makeConflictError(
  'FRIEND_REQUEST_UNAVAILABLE',
  'This player cannot receive friend requests right now',
);

// The caller's own chat block is disclosed because it is the caller's state.
export const BlockedBySelfError = makeConflictError(
  'BLOCKED_BY_SELF',
  'You have blocked this player - unblock them first',
);
export const AlreadyFriendsError = makeConflictError(
  'ALREADY_FRIENDS',
  'You are already friends with this player',
);
export const RequestAlreadyPendingError = makeConflictError(
  'REQUEST_ALREADY_PENDING',
  'A friend request to this player is already pending',
);
export const FriendRequestRefusedError = makeConflictError(
  'FRIEND_REQUEST_REFUSED',
  'This friend request was refused',
);

export const FriendshipNotFoundError = makeNotFoundError('Friendship');

export const FriendRequestNotFoundError = makeNotFoundError('FriendRequest');

function pgErrorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) {
    return undefined;
  }
  if ('code' in e && typeof e.code === 'string') {
    return e.code;
  }
  if ('cause' in e) {
    return pgErrorCode(e.cause);
  }
  return undefined;
}

function isUniqueConstraintViolation(e: unknown): boolean {
  return pgErrorCode(e) === '23505';
}

function toFriendshipDto(row: FriendshipRow) {
  return serializeRow(row, {
    dateFields: ['createdAt', 'acceptedAt', 'refusedAt'],
  });
}

// Finds the single row for a pair regardless of who is requester/addressee - the
// canonical-pair unique index guarantees at most one match.
function pairCondition(userA: Uuid, userB: Uuid) {
  return or(
    and(eq(friendship.requesterId, userA), eq(friendship.addresseeId, userB)),
    and(eq(friendship.requesterId, userB), eq(friendship.addresseeId, userA)),
  );
}

export class SocialService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly identityReader: IdentityReader,
  ) {}

  async sendFriendRequest(callerId: Uuid, targetUserId: Uuid): Promise<Friendship> {
    if (targetUserId === callerId) {
      throw new SelfFriendRequestError();
    }

    // Batched: caller + target resolved in one query rather than two round trips.
    const players = await this.drizzle.db
      .select({ userId: player.userId, username: user.username, status: player.status })
      .from(player)
      .innerJoin(user, eq(user.id, player.userId))
      .where(inArray(player.userId, [callerId, targetUserId]));
    const targetPlayer = players.find((p) => p.userId === targetUserId);
    const callerPlayer = players.find((p) => p.userId === callerId);

    if (!targetPlayer) {
      throw new FriendRequestTargetNotFoundError(targetUserId);
    }
    if (targetPlayer.status === 'suspended' || targetPlayer.status === 'closed') {
      throw new FriendRequestUnavailableError();
    }
    if (!callerPlayer) {
      // Invariant: an authenticated caller always has a player row. Not a domain
      // error (nothing the caller can act on) - fail loudly instead of masking it.
      throw new Error(`Player profile missing for authenticated caller: ${callerId}`);
    }

    // Both directions checked in one query: at most the two rows for this pair exist.
    const blocks = await this.drizzle.db
      .select({ blockerId: chatUserBlock.blockerId, blockedId: chatUserBlock.blockedId })
      .from(chatUserBlock)
      .where(and(isNull(chatUserBlock.removedAt), pairBlockCondition(callerId, targetUserId)));
    if (blocks.some((b) => b.blockerId === targetUserId && b.blockedId === callerId)) {
      // Target has blocked the caller - never disclosed, same error as "suspended".
      throw new FriendRequestUnavailableError();
    }
    if (blocks.some((b) => b.blockerId === callerId && b.blockedId === targetUserId)) {
      throw new BlockedBySelfError();
    }

    let inserted: FriendshipRow | undefined;
    try {
      const rows = await this.drizzle.db
        .insert(friendship)
        .values({ requesterId: callerId, addresseeId: targetUserId })
        .returning();
      inserted = rows[0];
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }

    if (inserted) {
      this.events.emit('social.friend_request.sent', {
        friendshipId: inserted.id,
        requesterId: inserted.requesterId,
        addresseeId: inserted.addresseeId,
        requesterUsername: callerPlayer.username ?? '',
      });
      return toFriendshipDto(inserted);
    }

    const accepted = await this.resolveExistingPair(callerId, targetUserId);
    this.events.emit('social.friend_request.accepted', {
      friendshipId: accepted.id,
      requesterId: accepted.requesterId,
      addresseeId: accepted.addresseeId,
      accepterId: callerId,
      accepterUsername: callerPlayer.username ?? '',
    });
    return toFriendshipDto(accepted);
  }

  private async resolveExistingPair(callerId: Uuid, targetUserId: Uuid): Promise<FriendshipRow> {
    return this.drizzle.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(friendship)
        .where(and(pairCondition(callerId, targetUserId), isNull(friendship.removedAt)))
        .for('update')
        .limit(1);
      const existing = rows[0];
      if (!existing) {
        // The row that caused the violation is gone (eg concurrently removed) -
        // safe to surface as "no longer pending", the caller can retry.
        throw new RequestAlreadyPendingError();
      }
      if (existing.refusedAt !== null) {
        throw new FriendRequestRefusedError();
      }
      if (existing.acceptedAt !== null) {
        throw new AlreadyFriendsError();
      }
      if (existing.requesterId === callerId) {
        throw new RequestAlreadyPendingError();
      }

      // Mutual/simultaneous case: existing.requesterId === targetUserId - the
      // pending row was already addressed TO the caller.
      const updatedRows = await tx
        .update(friendship)
        .set({ acceptedAt: new Date(), refusedAt: null })
        .where(eq(friendship.id, existing.id))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new RequestAlreadyPendingError();
      }
      return updated;
    });
  }

  /**
   * Batch relationship lookup for a set of target users, from the caller's point
   * of view. Reads are batched (one query per table, `IN (...)` over the target
   * ids) rather than N+1 per target.
   */
  async getRelationships(callerId: Uuid, targetUserIds: readonly Uuid[]): Promise<Relationship[]> {
    const uniqueTargetIds = [...new Set(targetUserIds)];

    const players = await this.drizzle.db
      .select({ userId: player.userId, status: player.status })
      .from(player)
      .where(inArray(player.userId, uniqueTargetIds));
    const playerByUserId = new Map(players.map((p) => [p.userId, p]));

    const friendships = await this.drizzle.db
      .select()
      .from(friendship)
      .where(
        and(
          or(
            and(
              eq(friendship.requesterId, callerId),
              inArray(friendship.addresseeId, uniqueTargetIds),
            ),
            and(
              inArray(friendship.requesterId, uniqueTargetIds),
              eq(friendship.addresseeId, callerId),
            ),
          ),
          isNull(friendship.removedAt),
        ),
      );
    const friendshipByTargetId = new Map<string, FriendshipRow>();
    for (const row of friendships) {
      const targetId = row.requesterId === callerId ? row.addresseeId : row.requesterId;
      friendshipByTargetId.set(targetId, row);
    }

    const blocks = await this.drizzle.db
      .select({ blockerId: chatUserBlock.blockerId, blockedId: chatUserBlock.blockedId })
      .from(chatUserBlock)
      .where(
        and(
          isNull(chatUserBlock.removedAt),
          or(
            and(
              eq(chatUserBlock.blockerId, callerId),
              inArray(chatUserBlock.blockedId, uniqueTargetIds),
            ),
            and(
              inArray(chatUserBlock.blockerId, uniqueTargetIds),
              eq(chatUserBlock.blockedId, callerId),
            ),
          ),
        ),
      );
    const blockedByMe = new Set(
      blocks.filter((b) => b.blockerId === callerId).map((b) => b.blockedId),
    );
    const blockedByTarget = new Set(
      blocks.filter((b) => b.blockedId === callerId).map((b) => b.blockerId),
    );

    return targetUserIds.map((userId): Relationship => {
      const targetPlayer = playerByUserId.get(userId);
      if (
        !targetPlayer ||
        targetPlayer.status === 'suspended' ||
        targetPlayer.status === 'closed' ||
        blockedByTarget.has(userId)
      ) {
        return { userId, status: 'unavailable', friendshipId: null, canSendRequest: false };
      }
      if (blockedByMe.has(userId)) {
        return { userId, status: 'blocked_by_me', friendshipId: null, canSendRequest: false };
      }

      const existing = friendshipByTargetId.get(userId);
      if (!existing) {
        return { userId, status: 'none', friendshipId: null, canSendRequest: true };
      }
      if (existing.refusedAt !== null) {
        return { userId, status: 'refused', friendshipId: existing.id, canSendRequest: false };
      }
      if (existing.acceptedAt !== null) {
        return { userId, status: 'friends', friendshipId: existing.id, canSendRequest: false };
      }
      const status = existing.requesterId === callerId ? 'pending_outgoing' : 'pending_incoming';
      return { userId, status, friendshipId: existing.id, canSendRequest: false };
    });
  }

  private async dissolveFriendship(
    tx: DrizzleDb,
    userA: Uuid,
    userB: Uuid,
    actorId: Uuid,
    reason: 'removed_by_player' | 'blocked',
  ): Promise<FriendshipDissolvedPayload | undefined> {
    const rows = await tx
      .update(friendship)
      .set({ removedAt: new Date() })
      .where(
        and(
          pairCondition(userA, userB),
          isNull(friendship.removedAt),
          isNotNull(friendship.acceptedAt),
        ),
      )
      .returning();
    const removed = rows[0];
    if (!removed) {
      return undefined;
    }

    return {
      friendshipId: removed.id,
      actorId,
      actorPlayerId: await this.identityReader.getPlayerIdByUserIdSafe(actorId),
      otherUserId: removed.requesterId === actorId ? removed.addresseeId : removed.requesterId,
      reason,
    };
  }

  async removeFriend(callerId: Uuid, targetUserId: Uuid): Promise<void> {
    const dissolved = await this.dissolveFriendship(
      this.drizzle.db,
      callerId,
      targetUserId,
      callerId,
      'removed_by_player',
    );
    if (!dissolved) {
      throw new FriendshipNotFoundError(targetUserId);
    }
    this.events.emit('social.friendship.removed', dissolved);
  }

  async dissolveFriendshipOnBlock(
    tx: unknown,
    blockerId: Uuid,
    blockedId: Uuid,
  ): Promise<FriendshipDissolvedPayload | null> {
    const dissolved = await this.dissolveFriendship(
      tx as DrizzleDb,
      blockerId,
      blockedId,
      blockerId,
      'blocked',
    );
    return dissolved ?? null;
  }

  async listFriends(
    callerId: Uuid,
    { page, limit }: { page: number; limit: number },
  ): Promise<{ items: FriendListEntry[]; total: number; page: number; limit: number }> {
    const where = and(
      or(eq(friendship.requesterId, callerId), eq(friendship.addresseeId, callerId)),
      isNotNull(friendship.acceptedAt),
      isNull(friendship.removedAt),
    );

    const [rows, countRows] = await Promise.all([
      this.drizzle.db
        .select({
          id: friendship.id,
          requesterId: friendship.requesterId,
          addresseeId: friendship.addresseeId,
          createdAt: friendship.createdAt,
        })
        .from(friendship)
        .where(where)
        .orderBy(desc(friendship.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(friendship).where(where),
    ]);

    const otherUserIds = rows.map((row) =>
      row.requesterId === callerId ? row.addresseeId : row.requesterId,
    );
    const [players, ignores] =
      otherUserIds.length > 0
        ? await Promise.all([
            this.drizzle.db
              .select({
                userId: player.userId,
                username: user.username,
                lastSeenAt: player.lastSeenAt,
                status: player.status,
              })
              .from(player)
              .innerJoin(user, eq(user.id, player.userId))
              .where(inArray(player.userId, otherUserIds)),
            this.drizzle.db
              .select({ ignoredId: chatUserIgnore.ignoredId })
              .from(chatUserIgnore)
              .where(
                and(
                  eq(chatUserIgnore.ignorerId, callerId),
                  isNull(chatUserIgnore.removedAt),
                  inArray(chatUserIgnore.ignoredId, otherUserIds),
                ),
              ),
          ])
        : [[], []];
    const playerByUserId = new Map(players.map((p) => [p.userId, p]));
    const ignoredIds = new Set(ignores.map((i) => i.ignoredId));

    const now = Date.now();

    const items = rows.flatMap((row) => {
      const userId = row.requesterId === callerId ? row.addresseeId : row.requesterId;
      const targetPlayer = playerByUserId.get(userId);
      if (!targetPlayer) {
        logger.error(
          { friendshipId: row.id, userId },
          'listFriends: player row missing for friend',
        );
        return [];
      }
      if (targetPlayer.status === 'suspended' || targetPlayer.status === 'closed') {
        return [];
      }
      const isOnline =
        targetPlayer.lastSeenAt !== null &&
        now - targetPlayer.lastSeenAt.getTime() <= ONLINE_STATUS_WINDOW_MS;
      return [
        serializeRow(
          {
            userId,
            friendshipId: row.id,
            username: targetPlayer.username ?? '',
            status: isOnline ? ('online' as const) : ('offline' as const),
            lastSeenAt: targetPlayer.lastSeenAt,
            isIgnored: ignoredIds.has(userId),
          },
          { dateFields: ['lastSeenAt'] as const },
        ),
      ];
    });

    return { items, total: Number(countRows[0]?.n ?? 0), page, limit };
  }

  async acceptFriendRequest(callerId: Uuid, friendshipId: Uuid): Promise<Friendship> {
    const [pending] = await this.drizzle.db
      .select({ requesterId: friendship.requesterId })
      .from(friendship)
      .where(
        and(
          eq(friendship.id, friendshipId),
          eq(friendship.addresseeId, callerId),
          isNull(friendship.acceptedAt),
          isNull(friendship.refusedAt),
          isNull(friendship.removedAt),
        ),
      );
    if (!pending) {
      throw new FriendRequestNotFoundError(friendshipId);
    }

    const blocks = await this.drizzle.db
      .select({ blockerId: chatUserBlock.blockerId })
      .from(chatUserBlock)
      .where(
        and(isNull(chatUserBlock.removedAt), pairBlockCondition(callerId, pending.requesterId)),
      );
    if (blocks.length > 0) {
      throw new FriendRequestUnavailableError();
    }

    const rows = await this.drizzle.db
      .update(friendship)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(friendship.id, friendshipId),
          eq(friendship.addresseeId, callerId),
          isNull(friendship.acceptedAt),
          isNull(friendship.refusedAt),
          isNull(friendship.removedAt),
        ),
      )
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new FriendRequestNotFoundError(friendshipId);
    }

    const [callerPlayer] = await this.drizzle.db
      .select({ username: user.username })
      .from(player)
      .innerJoin(user, eq(user.id, player.userId))
      .where(eq(player.userId, callerId));
    if (!callerPlayer) {
      // Invariant: an authenticated caller always has a player row (see
      // sendFriendRequest's same guard).
      throw new Error(`Player profile missing for authenticated caller: ${callerId}`);
    }

    this.events.emit('social.friend_request.accepted', {
      friendshipId: updated.id,
      requesterId: updated.requesterId,
      addresseeId: updated.addresseeId,
      accepterId: callerId,
      accepterUsername: callerPlayer.username ?? '',
    });
    return toFriendshipDto(updated);
  }

  async declineFriendRequest(callerId: Uuid, friendshipId: Uuid): Promise<void> {
    // removedAt (not refusedAt - the two are mutually exclusive, see the
    // friendship_removed_excludes_refused_key check constraint) frees the pair's
    // partial-unique slot, same as cancelFriendRequest - decline and cancel both
    // let either side send a new request afterwards.
    const rows = await this.drizzle.db
      .update(friendship)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(friendship.id, friendshipId),
          eq(friendship.addresseeId, callerId),
          isNull(friendship.acceptedAt),
          isNull(friendship.refusedAt),
          isNull(friendship.removedAt),
        ),
      )
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new FriendRequestNotFoundError(friendshipId);
    }

    this.events.emit('social.friend_request.declined', {
      friendshipId: updated.id,
      requesterId: updated.requesterId,
      addresseeId: updated.addresseeId,
    });
  }

  async cancelFriendRequest(callerId: Uuid, friendshipId: Uuid): Promise<void> {
    const rows = await this.drizzle.db
      .update(friendship)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(friendship.id, friendshipId),
          eq(friendship.requesterId, callerId),
          isNull(friendship.acceptedAt),
          isNull(friendship.refusedAt),
          isNull(friendship.removedAt),
        ),
      )
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new FriendRequestNotFoundError(friendshipId);
    }

    this.events.emit('social.friend_request.cancelled', {
      friendshipId: updated.id,
      requesterId: updated.requesterId,
      addresseeId: updated.addresseeId,
    });
  }

  async listFriendRequests(
    callerId: Uuid,
    { direction, page, limit }: { direction: FriendRequestDirection; page: number; limit: number },
  ): Promise<{ items: FriendRequestEntry[]; total: number; page: number; limit: number }> {
    const directionColumn =
      direction === 'incoming' ? friendship.addresseeId : friendship.requesterId;
    const where = and(
      eq(directionColumn, callerId),
      isNull(friendship.acceptedAt),
      isNull(friendship.refusedAt),
      isNull(friendship.removedAt),
    );

    const [rows, countRows] = await Promise.all([
      this.drizzle.db
        .select({
          id: friendship.id,
          requesterId: friendship.requesterId,
          addresseeId: friendship.addresseeId,
          createdAt: friendship.createdAt,
        })
        .from(friendship)
        .where(where)
        .orderBy(desc(friendship.createdAt))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ n: count() }).from(friendship).where(where),
    ]);

    const counterpartIds = rows.map((row) =>
      direction === 'incoming' ? row.requesterId : row.addresseeId,
    );

    const [players, mutualCounts, blocks] = await Promise.all([
      counterpartIds.length > 0
        ? this.drizzle.db
            .select({
              userId: player.userId,
              username: user.username,
              status: player.status,
            })
            .from(player)
            .innerJoin(user, eq(user.id, player.userId))
            .where(inArray(player.userId, counterpartIds))
        : Promise.resolve([]),
      direction === 'incoming' && counterpartIds.length > 0
        ? this.getMutualFriendsCounts(callerId, counterpartIds)
        : Promise.resolve(new Map<string, number>()),
      counterpartIds.length > 0
        ? this.drizzle.db
            .select({ blockerId: chatUserBlock.blockerId, blockedId: chatUserBlock.blockedId })
            .from(chatUserBlock)
            .where(
              and(
                isNull(chatUserBlock.removedAt),
                or(
                  and(
                    eq(chatUserBlock.blockerId, callerId),
                    inArray(chatUserBlock.blockedId, counterpartIds),
                  ),
                  and(
                    inArray(chatUserBlock.blockerId, counterpartIds),
                    eq(chatUserBlock.blockedId, callerId),
                  ),
                ),
              ),
            )
        : Promise.resolve([]),
    ]);
    const playerByUserId = new Map(players.map((p) => [p.userId, p]));
    // Either direction hides the pair - a blocked player never appears in requests on both sides
    const blockedCounterpartIds = new Set(
      blocks.map((b) => (b.blockerId === callerId ? b.blockedId : b.blockerId)),
    );

    const items = rows.flatMap((row) => {
      const counterpartId = direction === 'incoming' ? row.requesterId : row.addresseeId;
      const counterpartPlayer = playerByUserId.get(counterpartId);
      if (!counterpartPlayer) {
        logger.error(
          { friendshipId: row.id, counterpartId },
          'listFriendRequests: player row missing for counterpart',
        );
        return [];
      }
      if (counterpartPlayer.status === 'suspended' || counterpartPlayer.status === 'closed') {
        return [];
      }
      if (blockedCounterpartIds.has(counterpartId)) {
        return [];
      }
      return [
        serializeRow(
          {
            friendshipId: row.id,
            userId: counterpartId,
            username: counterpartPlayer.username ?? '',
            direction,
            createdAt: row.createdAt,
            mutualFriendsCount:
              direction === 'incoming' ? (mutualCounts.get(counterpartId) ?? 0) : null,
          },
          { dateFields: ['createdAt'] as const },
        ),
      ];
    });

    return { items, total: Number(countRows[0]?.n ?? 0), page, limit };
  }

  private async getMutualFriendsCounts(
    callerId: Uuid,
    requesterIds: readonly Uuid[],
  ): Promise<Map<string, number>> {
    const requesterInSet = inArray(friendship.requesterId, requesterIds);

    const callerFriends = this.drizzle.db
      .select({
        friendId: new SQL.Aliased<string>(
          sql<string>`CASE WHEN ${eq(friendship.requesterId, callerId)} THEN ${friendship.addresseeId} ELSE ${friendship.requesterId} END`,
          'caller_friend_id',
        ),
      })
      .from(friendship)
      .where(
        and(
          or(eq(friendship.requesterId, callerId), eq(friendship.addresseeId, callerId)),
          isNotNull(friendship.acceptedAt),
          isNull(friendship.removedAt),
        ),
      )
      .as('caller_friends');

    const requesterFriends = this.drizzle.db
      .select({
        otherId: new SQL.Aliased<string>(
          sql<string>`CASE WHEN ${requesterInSet} THEN ${friendship.requesterId} ELSE ${friendship.addresseeId} END`,
          'other_id',
        ),
        friendId: new SQL.Aliased<string>(
          sql<string>`CASE WHEN ${requesterInSet} THEN ${friendship.addresseeId} ELSE ${friendship.requesterId} END`,
          'requester_friend_id',
        ),
      })
      .from(friendship)
      .where(
        and(
          or(
            inArray(friendship.requesterId, requesterIds),
            inArray(friendship.addresseeId, requesterIds),
          ),
          isNotNull(friendship.acceptedAt),
          isNull(friendship.removedAt),
        ),
      )
      .as('requester_friends');

    const rows = await this.drizzle.db
      .select({
        requesterId: requesterFriends.otherId,
        mutualCount: sql<string>`count(distinct ${callerFriends.friendId})`,
      })
      .from(requesterFriends)
      .innerJoin(callerFriends, eq(requesterFriends.friendId, callerFriends.friendId))
      .groupBy(requesterFriends.otherId);

    return new Map(rows.map((row) => [row.requesterId, Number(row.mutualCount)]));
  }
}

function pairBlockCondition(callerId: Uuid, targetUserId: Uuid) {
  return or(
    and(eq(chatUserBlock.blockerId, targetUserId), eq(chatUserBlock.blockedId, callerId)),
    and(eq(chatUserBlock.blockerId, callerId), eq(chatUserBlock.blockedId, targetUserId)),
  );
}
