import {
  pgTable,
  text,
  boolean,
  jsonb,
  timestamp,
  uuid,
  unique,
  decimal,
} from 'drizzle-orm/pg-core';
import type { CommandConfig } from '../contract/index.js';

export const chatCommandConfig = pgTable(
  'chat_command_config',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull(),
    enabled: boolean().notNull().default(true),
    label: text().notNull(),
    description: text(),
    config: jsonb().$type<CommandConfig>(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('chat_command_config_key_unique').on(t.key)],
);

export type ChatCommandConfig = typeof chatCommandConfig.$inferSelect;

/**
 * Claimable gift card: sender is debited on send, first other player to claim
 * wins the credit. No FK to chatMessage — cross-module boundary rule.
 */
export const chatGift = pgTable('chat_gift', {
  id: uuid().primaryKey().defaultRandom(),
  // System message id from the chat module; plain UUID, no FK across module boundary.
  messageId: uuid().notNull(),
  senderId: uuid().notNull(),
  senderUsername: text().notNull(),
  amount: decimal({ precision: 18, scale: 8 }).notNull(),
  currency: text().notNull(),
  roomId: uuid().notNull(),
  claimedBy: uuid(),
  claimedByUsername: text(),
  claimedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type ChatGift = typeof chatGift.$inferSelect;
