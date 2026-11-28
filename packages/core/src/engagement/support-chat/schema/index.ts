import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const supportChatCustomer = pgTable('support_chat_customer', {
  playerId: uuid().primaryKey(),
  providerCustomerId: text().notNull().unique('support_chat_customer_provider_customer_id_unique'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type SupportChatCustomer = typeof supportChatCustomer.$inferSelect;
