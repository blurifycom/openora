import { tagAssignRemoveSource, tagKeys } from '@openora/core/contracts';
import { isNull } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  boolean,
  pgEnum,
  integer,
  decimal,
} from 'drizzle-orm/pg-core';

export const tagAssignRemoveSourceEnum = pgEnum('tag_assign_remove_source', tagAssignRemoveSource);
export const tagKeyEnum = pgEnum('tag_key', tagKeys);

export const tag = pgTable('tag', {
  id: uuid().primaryKey().defaultRandom(),
  key: tagKeyEnum().notNull().unique(),
  isSticky: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const playerTag = pgTable(
  'player_tag',
  {
    id: uuid().primaryKey().defaultRandom(),
    playerId: uuid().notNull() /* Potential FKey - player */,
    tagId: uuid()
      .notNull()
      .references(() => tag.id, {
        onDelete: 'restrict',
      }),
    /* Assign data (assignedAt -> createdAt used) */
    assignReason: text().notNull(),
    assignActor: tagAssignRemoveSourceEnum().notNull(),
    assignActorUserId: uuid() /* Potential FKey - user; null = system actor */,
    /* Removal data */
    removedAt: timestamp({ withTimezone: true }),
    removalReason: text(),
    removalActor: tagAssignRemoveSourceEnum(),
    removalActorUserId: uuid() /* Potential FKey - user */,
    /* Common timestamps */
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('player_tag_player_tag_idx').on(table.playerId, table.tagId),
    index('player_tag_tag_id_idx').on(table.tagId).where(isNull(table.removedAt)),
    // DB-level source of truth for "at most one active assignment per (tag, player)" -
    // the service pre-check is a friendly fast path only; this index is what actually
    // closes the concurrent-insert / at-least-once-redelivery race.
    uniqueIndex('player_tag_active_key')
      .on(table.tagId, table.playerId)
      .where(isNull(table.removedAt)),
  ],
);

export type Tag = typeof tag.$inferSelect;
export type PlayerTag = typeof playerTag.$inferSelect;

export const tagRule = pgTable('tag_rule', {
  id: uuid().primaryKey().defaultRandom(),
  tagId: uuid()
    .notNull()
    .references(() => tag.id, { onDelete: 'restrict' })
    .unique(),
  isEnabled: boolean().notNull().default(false),
  /** Amount threshold matching wallet money columns (high_roller: lifetime deposits; large_depositor: single deposit; high_risk: single withdrawal). */
  threshold: decimal({ precision: 18, scale: 2 }),
  /** Days threshold (inactive: days since last login; high_risk: rolling window for withdrawal count). */
  thresholdDays: integer(),
  /** Count threshold (high_risk: number of withdrawals within thresholdDays). */
  thresholdCount: integer(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type TagRule = typeof tagRule.$inferSelect;
