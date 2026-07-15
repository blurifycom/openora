import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { CHAT_ROOM_ROLES } from '../contract/constants.js';

const chatRoomRole = pgEnum('chat_room_role', CHAT_ROOM_ROLES);

export const chatRoom = pgTable(
  'chat_room',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    isPublic: boolean().notNull().default(true),
    // Set only for private rooms; null for public/admin-created rooms.
    joinCode: text(),
    creatorId: uuid(), // bare id - cross-module (user from pam/identity), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_room_slug_key').on(t.slug),
    uniqueIndex('chat_room_join_code_key').on(t.joinCode),
  ],
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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_msg_room_id_created_at_idx').on(t.roomId, t.createdAt),
    index('chat_msg_created_at_idx').on(t.createdAt),
  ],
);

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

export const chatRoomMember = pgTable(
  'chat_room_member',
  {
    id: uuid().primaryKey().defaultRandom(),
    roomId: uuid()
      .notNull()
      .references(() => chatRoom.id, { onDelete: 'cascade' }),
    userId: uuid().notNull(), // bare id - cross-module (user from pam/identity), no FK
    role: chatRoomRole().notNull().default('member'),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_room_member_room_user_key').on(t.roomId, t.userId),
    index('chat_room_member_room_idx').on(t.roomId),
    index('chat_room_member_user_idx').on(t.userId),
  ],
);

export const chatRoomBan = pgTable(
  'chat_room_ban',
  {
    id: uuid().primaryKey().defaultRandom(),
    roomId: uuid()
      .notNull()
      .references(() => chatRoom.id, { onDelete: 'cascade' }),
    userId: uuid().notNull(), // banned user - bare id
    bannedBy: uuid().notNull(), // moderator who banned - bare id
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_room_ban_room_user_key').on(t.roomId, t.userId),
    index('chat_room_ban_room_idx').on(t.roomId),
  ],
);

export type ChatRoom = typeof chatRoom.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type ChatUserBlock = typeof chatUserBlock.$inferSelect;
export type ChatRoomMember = typeof chatRoomMember.$inferSelect;
export type ChatRoomBan = typeof chatRoomBan.$inferSelect;
