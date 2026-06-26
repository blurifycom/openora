import { tagAssignRemoveSource } from '@blurifycom/core/contracts';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index, check, boolean, pgEnum } from 'drizzle-orm/pg-core';

export const tagAssignRemoveSourceEnum = pgEnum('tag_assign_remove_source', tagAssignRemoveSource);

export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    description: text('description'),
    isSticky: boolean('is_sticky').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* Ensures hex color check: #00ff00 | #0a1b53 as valid examples */
    check('tag_color_hex_check', sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
    index('tag_key_idx').on(table.key),
  ],
);

export const playerTag = pgTable(
  'player_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id').notNull() /* Potential FKey - player */,
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, {
        onDelete: 'restrict',
      }),
    /* Assign data (assignedAt -> createdAt used) */
    assignReason: text('assign_reason').notNull(),
    assignActor: tagAssignRemoveSourceEnum('assign_actor').notNull(),
    assignActorUserId: uuid('assign_actor_user_id').notNull() /* Potential FKey - user */,
    /* Removal data */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removalReason: text('removal_reason'),
    removalActor: tagAssignRemoveSourceEnum('removal_actor'),
    removalActorUserId: uuid('removal_actor_user_id') /* Potential FKey - user */,
    /* Common timestamps */
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdateFn(() => new Date()),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('player_tag_player_tag_idx').on(table.playerId, table.tagId)],
);

export type Tag = typeof tag.$inferSelect;
export type PlayerTag = typeof playerTag.$inferSelect;
