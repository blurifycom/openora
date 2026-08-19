import { pgTable, text, boolean, jsonb, timestamp, uuid, unique } from 'drizzle-orm/pg-core';
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
