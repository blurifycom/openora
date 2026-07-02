import { tagAssignRemoveSource, tagKeys } from '@blurifycom/core/contracts';
import { pgTable, uuid, text, timestamp, index, boolean, pgEnum } from 'drizzle-orm/pg-core';

export const tagAssignRemoveSourceEnum = pgEnum('tag_assign_remove_source', tagAssignRemoveSource);
export const tagKeyEnum = pgEnum('tag_key', tagKeys);

export const tag = pgTable('tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: tagKeyEnum('key').notNull().unique(),
  isSticky: boolean('is_sticky').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdateFn(() => new Date()),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
