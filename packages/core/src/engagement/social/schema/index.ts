import { sql } from 'drizzle-orm';
import { pgTable, uuid, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';

// Drizzle tables owned by the Social module.
// Rules:
//   - Column names come from the key via the snake_case casing config - never pass
//     an explicit string (lint: drizzle-snake-case).
//   - Timestamps are always `withTimezone` (lint: no-naive-timestamp).
//   - Do NOT add FK references to tables owned by another domain - reference by id.
// One row per friendship, directional at creation (requester -> addressee) but the
// PAIR is what must stay unique regardless of direction - the canonical-pair unique
// index below is what makes duplicate-request and the mutual/simultaneous-request
// race condition (see social.service.ts sendFriendRequest) safe at the DB level: an
// INSERT is attempted directly (no pre-SELECT), and a unique-violation on the pair
// key is caught and resolved. A request is pending while both decision timestamps
// are null, accepted when acceptedAt is set, and refused when refusedAt is set.
// A friendship is soft-removed (removedAt set) when either side dissolves it -
// SocialService.removeFriend (explicit) or dissolveFriendshipOnBlock (implicit, via
// the chat.user.blocked event) - same soft-delete pattern as chatUserBlock/
// chatUserIgnore (see chat/schema/index.ts): the pair unique index is partial
// (removedAt IS NULL) so re-friending after a removal inserts a fresh active row
// instead of conflicting with the removed one.
export const friendship = pgTable(
  'friendship',
  {
    id: uuid().primaryKey().defaultRandom(),
    requesterId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    addresseeId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    acceptedAt: timestamp({ withTimezone: true }),
    refusedAt: timestamp({ withTimezone: true }),
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // Canonical-pair unique index: the same two users can never have two ACTIVE rows
    // regardless of who sent the request. LEAST/GREATEST normalize the pair so
    // (A, B) and (B, A) collide on the same index entry. Partial (removedAt IS NULL)
    // so a removed friendship's row survives as history without blocking a fresh
    // request for the same pair - see chatUserBlock's pair index for the same pattern.
    uniqueIndex('friendship_pair_key')
      .on(
        sql`LEAST(${t.requesterId}, ${t.addresseeId})`,
        sql`GREATEST(${t.requesterId}, ${t.addresseeId})`,
      )
      .where(sql`${t.removedAt} IS NULL`),
    index('friendship_addressee_idx').on(t.addresseeId),
    index('friendship_requester_idx').on(t.requesterId),
    check(
      'friendship_one_decision_key',
      sql`NOT (${t.acceptedAt} IS NOT NULL AND ${t.refusedAt} IS NOT NULL)`,
    ),
    // A refused row can never also be soft-removed - refusal is a permanent block on
    // re-requesting the pair (see FriendRequestRefusedError), and removedAt must never
    // be set on a refused row (by convention, enforced here) so that permanence holds.
    // This otherwise allows removedAt on EITHER an accepted row (existing
    // remove-friend/dissolve-on-block flow) OR a still-pending row (never decided) -
    // the latter is what lets SocialService.cancelFriendRequest soft-remove a pending
    // request via the same mechanism: removedAt set, refusedAt left null, so the pair
    // drops out of the partial unique index (WHERE removedAt IS NULL) and can be
    // re-requested later (BF-426).
    check(
      'friendship_removed_excludes_refused_key',
      sql`NOT (${t.removedAt} IS NOT NULL AND ${t.refusedAt} IS NOT NULL)`,
    ),
  ],
);
export type Friendship = typeof friendship.$inferSelect;
