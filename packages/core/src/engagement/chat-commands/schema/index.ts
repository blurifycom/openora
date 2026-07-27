import { pgTable, text, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import type { CommandConfig } from '../contract/index.js';

export const chatCommandConfig = pgTable('chat_command_config', {
  key: text().primaryKey(),
  enabled: boolean().notNull().default(true),
  label: text().notNull(),
  description: text(),
  config: jsonb().$type<CommandConfig>(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type ChatCommandConfig = typeof chatCommandConfig.$inferSelect;
