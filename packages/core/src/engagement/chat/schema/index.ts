import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const chatRoom = pgTable(
  'chat_room',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    isPublic: boolean().notNull().default(true),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chat_room_slug_key').on(t.slug)],
);

export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid().primaryKey().defaultRandom(),
    roomId: uuid().references(() => chatRoom.id),
    userId: uuid().notNull(),
    username: text().notNull(),
    content: text().notNull(),
    isDeleted: boolean().notNull().default(false),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [
    index('chat_msg_room_id_created_at_idx').on(t.roomId, t.createdAt),
    index('chat_msg_created_at_idx').on(t.createdAt),
  ],
);

// A directional mute: `blockerId` no longer sees messages from `blockedId`.
// Scoped to the blocker only - the blocked player is unaffected (ABC-45 AC11).
// A directional mute: `blockerId` no longer sees messages from `blockedId`.
// Scoped to the blocker only - the blocked player is unaffected (ABC-45 AC11).
export const chatUserBlock = pgTable(
  'chat_user_block',
  {
    id: uuid().primaryKey().defaultRandom(),
    blockerId: uuid().notNull(),
    blockedId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_user_block_pair_key').on(t.blockerId, t.blockedId),
    index('chat_user_block_blocker_idx').on(t.blockerId),
  ],
);

export type ChatRoom = typeof chatRoom.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type ChatUserBlock = typeof chatUserBlock.$inferSelect;
