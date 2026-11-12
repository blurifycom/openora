import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  PrimaryKeyBuilder,
  boolean,
  uuid,
  check,
  bigserial,
} from 'drizzle-orm/pg-core';

// Transactional outbox table. A service writes the event envelope here INSIDE the
// same db.transaction as its state change (EventBus.emitInTransaction), so the row
// commits atomically with the state - the event can never be lost in the gap
// between "state changed" and "event published". The OutboxRelay claims pending
// rows (claimedAt lease), publishes them to the MESSAGE_BROKER and stamps
// publishedAt. Delivery is at-least-once; consumers dedup via processed_events.
// See ADR-0016 and ADR-0045.
export const eventOutbox = pgTable(
  'event_outbox',
  {
    eventId: text().primaryKey(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    schemaVersion: integer().notNull().default(1),
    traceId: text(),
    correlationId: text(),
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

// Audit records waiting for the audit shipper. A writer inserts the entry INSIDE its business
// transaction, so the record commits if and only if the change it describes does, without
// taking the audit chain lock there. The shipper appends rows to `audit_log` in `id` order and
// deletes them only after that append commits; `event_id` is the record's identity across a
// re-ship, so a crash between the two commits never writes a row twice. Part of the engine set
// so every database a service writes to carries one.
export const auditOutbox = pgTable('audit_outbox', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  eventId: uuid().notNull().unique('audit_outbox_event_id_unique'),
  entry: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// One row per deployment: the anonymous id the usage telemetry reports under. The check pins the
// table to a single row, so replicas racing on first boot converge on one id.
export const openoraInstance = pgTable(
  'openora_instance',
  {
    singleton: boolean().primaryKey().default(true),
    instanceId: uuid().notNull().defaultRandom(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('openora_instance_singleton', sql`${t.singleton}`)],
);

// Consumer-side dedup. One row per (event, handler) that finished successfully, so a
// redelivered event skips the handlers that already ran. `consumer` is the stable
// handler identity built in createApp: `<service>/<plugin>/<topic>[#n]`. Pruned by the
// OutboxRelay once older than the stream retention - past it the broker can no longer
// redeliver the event. See ADR-0045.
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
