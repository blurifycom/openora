import { pgTable, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core';

// Transactional outbox table. A money/critical service writes the event envelope
// here INSIDE the same db.transaction as its state change (via the OUTBOX port),
// so the row commits atomically with the state - the event can never be lost in
// the gap between "state changed" and "event published". The OutboxRelay then
// publishes pending rows to the MESSAGE_BROKER and stamps publishedAt. Delivery
// is at-least-once; consumers dedup on eventId. See ADR-0016.
export const eventOutbox = pgTable(
  'event_outbox',
  {
    // The envelope eventId (UUID) - also the consumer-side idempotency key.
    eventId: text('eventId').primaryKey(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    schemaVersion: integer('schemaVersion').notNull().default(1),
    tenantId: text('tenantId'),
    traceId: text('traceId'),
    orderingKey: text('orderingKey'),
    occurredAt: timestamp('occurredAt', { withTimezone: true }).notNull(),
    // null = pending publication; set once the relay has published it.
    publishedAt: timestamp('publishedAt', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('event_outbox_pending_idx').on(t.publishedAt, t.occurredAt)],
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
