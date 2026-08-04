import { pgTable, uuid, text, decimal, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Claimable gift card: sender is debited on send, first other player to claim
 * wins the credit. Successor to chat-commands' `chat_gift` table (left in
 * place, untouched - see chat-commands/AGENTS.md and this module's AGENTS.md).
 * No FK to chatMessage - cross-module boundary rule. roomId is nullable: a
 * gift can be sent into global chat (GLOBAL_CHAT_ROOM_ID sentinel on the wire).
 */
export const playerGift = pgTable('player_gift', {
  id: uuid().primaryKey().defaultRandom(),
  // System message id from the chat module; plain UUID, no FK across module boundary.
  messageId: uuid().notNull(),
  senderId: uuid().notNull(),
  senderUsername: text().notNull(),
  amount: decimal({ precision: 18, scale: 8 }).notNull(),
  currency: text().notNull(),
  roomId: uuid(),
  claimedBy: uuid(),
  claimedByUsername: text(),
  claimedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerGift = typeof playerGift.$inferSelect;

/** One row per `/donate` - a direct player-to-player tip. roomId is nullable: donate can happen outside a room context. */
export const playerDonate = pgTable('player_donate', {
  id: uuid().primaryKey().defaultRandom(),
  senderId: uuid().notNull(),
  senderUsername: text().notNull(),
  recipientId: uuid().notNull(),
  recipientUsername: text().notNull(),
  amount: decimal({ precision: 18, scale: 8 }).notNull(),
  currency: text().notNull(),
  roomId: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerDonate = typeof playerDonate.$inferSelect;

/**
 * Header row per `/rain` event. `amount` is the ACTUALLY-distributed total
 * (`floor(typedAmount / recipientCount) * recipientCount`), never the raw
 * player-typed amount - see this module's AGENTS.md. roomId is nullable: rain
 * can be sent into global chat (GLOBAL_CHAT_ROOM_ID sentinel on the wire).
 */
export const playerRain = pgTable('player_rain', {
  id: uuid().primaryKey().defaultRandom(),
  senderId: uuid().notNull(),
  amount: decimal({ precision: 18, scale: 8 }).notNull(),
  perRecipient: decimal({ precision: 18, scale: 8 }).notNull(),
  currency: text().notNull(),
  roomId: uuid(),
  recipientCount: integer().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerRain = typeof playerRain.$inferSelect;

/** One row per rain recipient. In-module FK to `player_rain` - same-module FKs are fine. */
export const playerRainReceiver = pgTable('player_rain_receiver', {
  id: uuid().primaryKey().defaultRandom(),
  rainId: uuid()
    .notNull()
    .references(() => playerRain.id),
  recipientId: uuid().notNull(),
  amount: decimal({ precision: 18, scale: 8 }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerRainReceiver = typeof playerRainReceiver.$inferSelect;
