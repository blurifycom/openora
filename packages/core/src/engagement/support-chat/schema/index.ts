import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

// One vendor chat customer per player. `playerId` is the profile's id, by value - no FK across
// modules. `providerCustomerId` is unique so two players can never share one vendor customer.
export const supportChatCustomer = pgTable('support_chat_customer', {
  playerId: uuid().primaryKey(),
  providerCustomerId: text().notNull().unique('support_chat_customer_provider_customer_id_unique'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type SupportChatCustomer = typeof supportChatCustomer.$inferSelect;
