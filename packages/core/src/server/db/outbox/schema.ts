import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  boolean,
  uuid,
  check,
} from 'drizzle-orm/pg-core';

// Transactional outbox table. A money/critical service writes the event envelope
// here INSIDE the same db.transaction as its state change (via the OUTBOX port),
// so the row commits atomically with the state - the event can never be lost in
// the gap between "state changed" and "event published". The OutboxRelay then
// publishes pending rows to the MESSAGE_BROKER and stamps publishedAt. Delivery
// is at-least-once; consumers dedup on eventId. See ADR-0016.
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
    attempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('event_outbox_pending_idx').on(t.publishedAt, t.occurredAt)],
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;

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
