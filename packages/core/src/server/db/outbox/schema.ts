import {
  pgTable,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  PrimaryKeyBuilder,
} from 'drizzle-orm/pg-core';

// Transactional outbox table. A service writes the event envelope here INSIDE the
// same db.transaction as its state change (EventBus.emitInTransaction), so the row
// commits atomically with the state - the event can never be lost in the gap
// between "state changed" and "event published". The OutboxRelay claims pending
// rows (claimedAt lease), publishes them to the MESSAGE_BROKER and stamps
// publishedAt. Delivery is at-least-once; consumers dedup via processed_events.
// See ADR-0016 and ADR-0044.
export const eventOutbox = pgTable(
  'event_outbox',
  {
    eventId: text().primaryKey(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    schemaVersion: integer().notNull().default(1),
    traceId: text(),
    orderingKey: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    publishedAt: timestamp({ withTimezone: true }),
    claimedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('event_outbox_pending_idx').on(t.publishedAt, t.occurredAt)],
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;

// Consumer-side dedup. One row per (event, handler) that finished successfully, so a
// redelivered event skips the handlers that already ran. `consumer` is the stable
// handler identity built in createApp: `<service>/<plugin>/<topic>[#n]`. Pruned by the
// OutboxRelay once older than the stream retention - past it the broker can no longer
// redeliver the event. See ADR-0044.
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: text().notNull(),
    consumer: text().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Same as primaryKey({ columns }); depretec flags every primaryKey() call because
    // of its deprecated variadic overload.
    new PrimaryKeyBuilder([t.eventId, t.consumer]),
    index('processed_events_processed_at_idx').on(t.processedAt),
  ],
);
