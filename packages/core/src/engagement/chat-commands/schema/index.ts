import {
  pgTable,
  text,
  boolean,
  jsonb,
  timestamp,
  uuid,
  unique,
  decimal,
  pgEnum,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { ChatSystemMessage } from '@openora/core/contracts';
import type { CommandConfig } from '../contract/index.js';
import { CHAT_COMMAND_TYPES } from '../contract/index.js';

export const chatCommandTypeEnum = pgEnum('chat_command_type', CHAT_COMMAND_TYPES);

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

/**
 * Idempotency guard for money-moving commands (gift/rain/donate). The row IS the
 * atomic guard: inserted (with a null `result`) BEFORE the debit inside the same
 * transaction, backfilled with the final result after - the same
 * insert-placeholder-then-backfill idiom `chatGift.messageId` already uses in this
 * module. A concurrent duplicate request loses the unique-index race and must NOT
 * touch money; the caller re-reads the winner's row instead (mirrors wallet's
 * insertIdempotentTransaction). `result` is jsonb because chat-commands doesn't own
 * chatMessage (chat module does) - storing the full ChatSystemMessage here avoids a
 * cross-module read on replay. `fingerprint` is a sha256 hash of the FULL command
 * input (every field, not just amount) - a replay must match the whole request, not
 * just the amount, or a reused key with a different room/recipient/donate target
 * would silently return the wrong stored result.
 */
export const chatCommandIdempotency = pgTable(
  'chat_command_idempotency',
  {
    id: uuid().primaryKey().defaultRandom(),
    actorId: uuid().notNull(),
    commandType: chatCommandTypeEnum().notNull(),
    idempotencyKey: uuid().notNull(),
    amount: decimal({ precision: 18, scale: 8 }).notNull(),
    fingerprint: text().notNull(),
    result: jsonb().$type<ChatSystemMessage>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_command_idempotency_actor_type_key_idx').on(
      t.actorId,
      t.commandType,
      t.idempotencyKey,
    ),
  ],
);
export type ChatCommandIdempotency = typeof chatCommandIdempotency.$inferSelect;
