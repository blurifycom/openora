import { pgTable, text, boolean, timestamp, uuid, unique } from 'drizzle-orm/pg-core';
import { zodJsonb } from '@openora/core/server';
import { CommandConfigSchema } from '../contract/index.js';

export const chatCommandConfig = pgTable(
  'chat_command_config',
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull(),
    enabled: boolean().notNull().default(true),
    label: text().notNull(),
    description: text(),
    config: zodJsonb(CommandConfigSchema, 'chat_command_config.config')(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('chat_command_config_key_unique').on(t.key)],
);

export type ChatCommandConfig = typeof chatCommandConfig.$inferSelect;
