import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  type DrizzleService,
  type EventBus,
  createDomainError,
  makeConflictError,
  makeNotFoundError,
  serializeRow,
} from '@openora/core/server';
import { type Uuid } from '@openora/core/contracts';
import { chatUserBlock } from '@openora/core/engagement/schema/chat';
import { player } from '@openora/core/pam/schema/profile';
import { friendship } from '../schema/index.js';
import { type Friendship, type Relationship } from '../contract/index.js';

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
        .where(pairCondition(callerId, targetUserId))
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
}

function pairBlockCondition(callerId: Uuid, targetUserId: Uuid) {
  return or(
    and(eq(chatUserBlock.blockerId, targetUserId), eq(chatUserBlock.blockedId, callerId)),
    and(eq(chatUserBlock.blockerId, callerId), eq(chatUserBlock.blockedId, targetUserId)),
  );
}
