import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const chatRoom = pgTable(
  'ChatRoom',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isPublic: boolean('isPublic').notNull().default(true),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chat_room_slug_key').on(t.slug)],
);

export const chatMessage = pgTable(
  'ChatMessage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('roomId').references(() => chatRoom.id),
    userId: uuid('userId').notNull(),
    username: text('username').notNull(),
    content: text('content').notNull(),
    isDeleted: boolean('isDeleted').notNull().default(false),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('chat_msg_roomId_createdAt_idx').on(t.roomId, t.createdAt),
    index('chat_msg_createdAt_idx').on(t.createdAt),
  ],
);

export type ChatRoom = typeof chatRoom.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
