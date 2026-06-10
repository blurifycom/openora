import { pgTable, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';

export const chatRoom = pgTable(
  'ChatRoom',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    tenantId: text('tenantId').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isPublic: boolean('isPublic').notNull().default(true),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chat_room_tenantId_slug_key').on(t.tenantId, t.slug)],
);

export const chatMessage = pgTable(
  'ChatMessage',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    tenantId: text('tenantId').notNull(),
    roomId: text('roomId').references(() => chatRoom.id),
    userId: text('userId').notNull(),
    username: text('username').notNull(),
    content: text('content').notNull(),
    isDeleted: boolean('isDeleted').notNull().default(false),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('chat_msg_roomId_createdAt_idx').on(t.roomId, t.createdAt),
    index('chat_msg_tenantId_createdAt_idx').on(t.tenantId, t.createdAt),
  ],
);

export type ChatRoom = typeof chatRoom.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
