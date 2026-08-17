import { and, count, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  type DrizzleService,
  type EventBus,
  createDomainError,
  createLogger,
  makeConflictError,
  makeNotFoundError,
  pageToOffset,
  serializeRow,
} from '@openora/core/server';
import { type IdentityReader, type Uuid } from '@openora/core/contracts';
import { chatUserBlock, chatUserIgnore } from '@openora/core/engagement/schema/chat';
import { player } from '@openora/core/pam/schema/profile';
import { friendship } from '../schema/index.js';
import { type Friendship, type FriendListEntry, type Relationship } from '../contract/index.js';

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

// No active, accepted friendship exists for the pair - thrown by removeFriend (a
// direct user action) only. dissolveFriendshipOnBlock silently no-ops instead: it
// runs from an event handler, not a user action, so "not friends" is a normal case.
export const FriendshipNotFoundError = makeNotFoundError('Friendship');

// Postgres unique-violation. friendship has exactly one unique index
// (friendship_pair_key), so any 23505 on an insert into it is unambiguous - no
// constraint-name check needed. drizzle-orm wraps the driver error in a
// DrizzleQueryError, so the pg error (and its `.code`) is on `.cause`, not the
// thrown error itself - checked against a real Postgres unique-index violation
// in social.service.int.test.ts (a mocked query builder can't catch this).
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

  /**
   * Sends a friend request from `callerId` to `targetUserId`. The insert is
   * attempted directly against the canonical-pair unique index (no pre-SELECT,
   * avoiding a TOCTOU race); a unique-violation means a row for this pair already
   * exists, which is resolved by re-reading it - including the mutual/simultaneous
   * case where the existing row was already addressed TO the caller, which
   * auto-accepts instead of conflicting. Events are emitted strictly after the
   * mutating statement/transaction has committed.
   */
  async sendFriendRequest(callerId: Uuid, targetUserId: Uuid): Promise<Friendship> {
    if (targetUserId === callerId) {
      throw new SelfFriendRequestError();
    }

    // Batched: caller + target resolved in one query rather than two round trips.
    const players = await this.drizzle.db
      .select({ userId: player.userId, displayName: player.displayName, status: player.status })
      .from(player)
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
        requesterDisplayName: callerPlayer.displayName,
      });
      return toFriendshipDto(inserted);
    }

    const accepted = await this.resolveExistingPair(callerId, targetUserId);
    this.events.emit('social.friend_request.accepted', {
      friendshipId: accepted.id,
      requesterId: accepted.requesterId,
      addresseeId: accepted.addresseeId,
      accepterId: callerId,
      accepterDisplayName: callerPlayer.displayName,
    });
    return toFriendshipDto(accepted);
  }

  /**
   * Re-reads the row a unique-violation on `friendship_pair_key` proved already
   * exists and resolves it: already accepted -> conflict, same-direction duplicate
   * -> conflict, opposite-direction (mutual/simultaneous request) -> auto-accept.
   * `FOR UPDATE` serializes this against a concurrent resolution of the same pair.
   */
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
          // A soft-removed friendship reads as "none" (able to re-friend), not stale
          // friends/refused state.
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
      if (existing?.refusedAt !== null && existing?.refusedAt !== undefined) {
        return { userId, status: 'refused', friendshipId: existing.id, canSendRequest: false };
      }
      if (existing?.acceptedAt !== null && existing?.acceptedAt !== undefined) {
        return { userId, status: 'friends', friendshipId: existing.id, canSendRequest: false };
      }
      if (
        existing?.acceptedAt === null &&
        existing?.refusedAt === null &&
        existing?.requesterId === callerId
      ) {
        return {
          userId,
          status: 'pending_outgoing',
          friendshipId: existing.id,
          canSendRequest: false,
        };
      }
      if (
        existing?.acceptedAt === null &&
        existing?.refusedAt === null &&
        existing?.requesterId === userId
      ) {
        return {
          userId,
          status: 'pending_incoming',
          friendshipId: existing.id,
          canSendRequest: false,
        };
      }
      return { userId, status: 'none', friendshipId: null, canSendRequest: true };
    });
  }

  private async dissolveFriendship(
    userA: Uuid,
    userB: Uuid,
    actorId: Uuid,
    reason: 'removed_by_player' | 'blocked',
  ): Promise<FriendshipRow | undefined> {
    const rows = await this.drizzle.db
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

    this.events.emit('social.friendship.removed', {
      friendshipId: removed.id,
      actorId,
      actorPlayerId: await this.identityReader.getPlayerIdByUserIdSafe(actorId),
      otherUserId: removed.requesterId === actorId ? removed.addresseeId : removed.requesterId,
      reason,
    });
    return removed;
  }

  async removeFriend(callerId: Uuid, targetUserId: Uuid): Promise<void> {
    const removed = await this.dissolveFriendship(
      callerId,
      targetUserId,
      callerId,
      'removed_by_player',
    );
    if (!removed) {
      throw new FriendshipNotFoundError(targetUserId);
    }
  }

  async dissolveFriendshipOnBlock(blockerId: Uuid, blockedId: Uuid): Promise<void> {
    await this.dissolveFriendship(blockerId, blockedId, blockerId, 'blocked');
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
                displayName: player.displayName,
                lastSeenAt: player.lastSeenAt,
              })
              .from(player)
              .where(inArray(player.userId, otherUserIds)),
            // The caller's OWN ignore state on each friend - Confluence Scenario 3
            // requires the menu to read "Unignore" for a friend already ignored.
            // Never the reverse direction: the other party ignoring the caller is
            // their own state, not disclosed here.
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
    // Player row should always exist (players are deactivated, never hard-deleted -
    // see module-structure.md), so a miss means an orphaned friendship row, not a
    // normal case - log it and drop the entry rather than render a blank-name row.
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
      const isOnline =
        targetPlayer.lastSeenAt !== null &&
        now - targetPlayer.lastSeenAt.getTime() <= ONLINE_STATUS_WINDOW_MS;
      return [
        serializeRow(
          {
            userId,
            friendshipId: row.id,
            displayName: targetPlayer.displayName,
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
}

function pairBlockCondition(callerId: Uuid, targetUserId: Uuid) {
  return or(
    and(eq(chatUserBlock.blockerId, targetUserId), eq(chatUserBlock.blockedId, callerId)),
    and(eq(chatUserBlock.blockerId, callerId), eq(chatUserBlock.blockedId, targetUserId)),
  );
}
