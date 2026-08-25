import {
  pgTable,
  text,
  boolean,
  jsonb,
  timestamp,
  uuid,
  unique,
  decimal,
  integer,
} from 'drizzle-orm/pg-core';
import { MONEY_PRECISION, MONEY_SCALE } from '@openora/core/contracts';
import type { CommandChatMessage } from '@openora/core/contracts';
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

export const chatCommandIdempotency = pgTable(
  'chat_command_idempotency',
  {
    id: uuid().primaryKey().defaultRandom(),
    actorId: uuid().notNull(),
    commandType: text().notNull(),
    idempotencyKey: uuid().notNull(),
    fingerprint: text().notNull(),
    result: jsonb().$type<CommandChatMessage>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('chat_command_idempotency_actor_command_key_unique').on(
      t.actorId,
      t.commandType,
      t.idempotencyKey,
    ),
  ],
);
export type ChatCommandIdempotency = typeof chatCommandIdempotency.$inferSelect;

export const playerGift = pgTable('player_gift', {
  id: uuid().primaryKey().defaultRandom(),
  messageId: uuid().notNull(),
  senderId: uuid().notNull(),
  senderUsername: text().notNull(),
  amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  currency: text().notNull(),
  roomId: uuid(),
  claimedBy: uuid(),
  claimedByUsername: text(),
  claimedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerGift = typeof playerGift.$inferSelect;

export const playerDonate = pgTable('player_donate', {
  id: uuid().primaryKey().defaultRandom(),
  senderId: uuid().notNull(),
  senderUsername: text().notNull(),
  recipientId: uuid().notNull(),
  recipientUsername: text().notNull(),
  amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  currency: text().notNull(),
  roomId: uuid(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerDonate = typeof playerDonate.$inferSelect;

export const playerRain = pgTable('player_rain', {
  id: uuid().primaryKey().defaultRandom(),
  senderId: uuid().notNull(),
  amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  perRecipient: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  currency: text().notNull(),
  roomId: uuid(),
  recipientCount: integer().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerRain = typeof playerRain.$inferSelect;

export const playerRainReceiver = pgTable('player_rain_receiver', {
  id: uuid().primaryKey().defaultRandom(),
  rainId: uuid()
    .notNull()
    .references(() => playerRain.id),
  recipientId: uuid().notNull(),
  amount: decimal({ precision: MONEY_PRECISION, scale: MONEY_SCALE }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export type PlayerRainReceiver = typeof playerRainReceiver.$inferSelect;
