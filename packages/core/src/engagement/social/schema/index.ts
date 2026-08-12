import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { FRIENDSHIP_STATUSES } from '../contract/index.js';

// Drizzle tables owned by the Social module.
// Rules:
//   - Column names come from the key via the snake_case casing config - never pass
//     an explicit string (lint: drizzle-snake-case).
//   - Timestamps are always `withTimezone` (lint: no-naive-timestamp).
//   - Do NOT add FK references to tables owned by another domain - reference by id.
export const friendshipStatus = pgEnum('friendship_status', FRIENDSHIP_STATUSES);

// One row per friendship, directional at creation (requester -> addressee) but the
// PAIR is what must stay unique regardless of direction - the canonical-pair unique
// index below is what makes duplicate-request and the mutual/simultaneous-request
// race condition (see social.service.ts sendFriendRequest) safe at the DB level: an
// INSERT is attempted directly (no pre-SELECT), and a unique-violation on the pair
// key is caught and resolved. decline/cancel/remove all delete the row - there is no
// 'declined'/'removed' status; FRIENDSHIP_STATUSES only ever holds 'pending'/'accepted'.
export const friendship = pgTable(
  'friendship',
  {
    id: uuid().primaryKey().defaultRandom(),
    requesterId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    addresseeId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    status: friendshipStatus().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
    // Set only when a row transitions to 'accepted'; null while pending.
    respondedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // Canonical-pair unique index: the same two users can never have two rows
    // regardless of who sent the request. LEAST/GREATEST normalize the pair so
    // (A, B) and (B, A) collide on the same index entry.
    uniqueIndex('friendship_pair_key').on(
      sql`LEAST(${t.requesterId}, ${t.addresseeId})`,
      sql`GREATEST(${t.requesterId}, ${t.addresseeId})`,
    ),
    index('friendship_addressee_status_idx').on(t.addresseeId, t.status),
    index('friendship_requester_status_idx').on(t.requesterId, t.status),
  ],
);
export type Friendship = typeof friendship.$inferSelect;

// Schema only in this PR - no create/remove-block route ships yet (a later ticket
// adds the write endpoints). Exists so sendFriendRequest's "blocked" gate is real,
// not stubbed. Mirrors chat's chatUserBlock shape (soft-deleted via removedAt,
// partial unique index on the active pair) without reusing that table - this is a
// distinct relationship, scoped to the social/friends surface, not chat muting.
export const socialUserBlock = pgTable(
  'social_user_block',
  {
    id: uuid().primaryKey().defaultRandom(),
    blockerId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    blockedId: uuid().notNull(), // bare id - cross-module (user from pam), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Soft-delete = unblock. No row is ever soft-deleted by this PR (no
    // block/unblock write routes ship yet), but the column must exist now so
    // adding it isn't a migration later.
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('social_user_block_pair_key')
      .on(t.blockerId, t.blockedId)
      .where(sql`${t.removedAt} IS NULL`),
    // The side this PR actually queries: "who has blocked me" (sendFriendRequest
    // step 3) and "has the target blocked the caller" (getRelationships).
    index('social_user_block_blocked_idx').on(t.blockedId),
  ],
);
export type SocialUserBlock = typeof socialUserBlock.$inferSelect;
