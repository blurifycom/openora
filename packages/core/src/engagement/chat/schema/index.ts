import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { CHAT_ROOM_CATEGORIES, CHAT_ROOM_ROLES } from '../contract/index.js';
import { CHAT_MESSAGE_TYPES } from '@openora/core/contracts';
import type { CommandMetadata } from '@openora/core/contracts';

export const chatRoomRole = pgEnum('chat_room_role', CHAT_ROOM_ROLES);
export const chatRoomCategory = pgEnum('chat_room_category', CHAT_ROOM_CATEGORIES);
export const chatMessageType = pgEnum('chat_message_type', CHAT_MESSAGE_TYPES);

export const chatRoom = pgTable(
  'chat_room',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    slug: text().notNull(),
    category: chatRoomCategory().notNull().default('games-sports'),
    isPublic: boolean().notNull().default(true),
    // Set only for private rooms; null for public/admin-created rooms.
    joinCode: text(),
    creatorId: uuid(), // bare id - cross-module (user from pam/identity), no FK
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chat_room_slug_key').on(t.slug),
    uniqueIndex('chat_room_join_code_key').on(t.joinCode),
    index('chat_room_deleted_at_idx').on(t.deletedAt),
    index('chat_room_creator_public_deleted_at_idx').on(t.creatorId, t.isPublic, t.deletedAt),
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
    type: chatMessageType().notNull().default('user'),
    metadata: jsonb().$type<CommandMetadata>(),
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
// Soft-deleted: unblock sets removedAt rather than deleting the row, so the pair's
// block history survives. The unique pair index is partial (active rows only) so a
// block -> unblock -> re-block cycle inserts a new active row instead of conflicting
// with the removed one - see chat.service.ts blockUser/unblockUser.
export const chatUserBlock = pgTable(
  'chat_user_block',
  {
    id: uuid().primaryKey().defaultRandom(),
    blockerId: uuid().notNull(),
    blockedId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chat_user_block_pair_key')
      .on(t.blockerId, t.blockedId)
      .where(sql`${t.removedAt} IS NULL`),
    index('chat_user_block_blocker_idx').on(t.blockerId),
  ],
);

// A directional soft-mute: `ignorerId` no longer sees messages from `ignoredId`.
// A separate relationship from chatUserBlock (not an alias) - same message-hiding
// effect for now, but block vs ignore may diverge further later. Soft-deleted the
// same way as chatUserBlock - see the comment there.
export const chatUserIgnore = pgTable(
  'chat_user_ignore',
  {
    id: uuid().primaryKey().defaultRandom(),
    ignorerId: uuid().notNull(),
    ignoredId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chat_user_ignore_pair_key')
      .on(t.ignorerId, t.ignoredId)
      .where(sql`${t.removedAt} IS NULL`),
    index('chat_user_ignore_ignorer_idx').on(t.ignorerId),
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

export const chatPlatformBan = pgTable(
  'chat_platform_ban',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    bannedBy: uuid().notNull(),
    reason: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp({ withTimezone: true }),
    liftedBy: uuid(),
  },
  (t) => [
    uniqueIndex('chat_platform_ban_active_user_key')
      .on(t.userId)
      .where(sql`${t.liftedAt} IS NULL`),
    index('chat_platform_ban_user_idx').on(t.userId),
  ],
);

export const chatMute = pgTable(
  'chat_mute',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull(),
    roomId: uuid(), // null = global chat; public room ids are channel-scoped mutes
    mutedBy: uuid().notNull(),
    reason: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }),
    liftedAt: timestamp({ withTimezone: true }),
    liftedBy: uuid(),
  },
  (t) => [
    index('chat_mute_user_room_idx').on(t.userId, t.roomId),
    index('chat_mute_expires_at_idx').on(t.expiresAt),
  ],
);

export type ChatRoom = typeof chatRoom.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type ChatUserBlock = typeof chatUserBlock.$inferSelect;
export type ChatUserIgnore = typeof chatUserIgnore.$inferSelect;
export type ChatRoomMember = typeof chatRoomMember.$inferSelect;
export type ChatRoomBan = typeof chatRoomBan.$inferSelect;
export type ChatPlatformBan = typeof chatPlatformBan.$inferSelect;
export type ChatMute = typeof chatMute.$inferSelect;
