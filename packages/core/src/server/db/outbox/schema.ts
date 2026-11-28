import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgSequence,
  text,
  jsonb,
  integer,
  bigint,
  timestamp,
  index,
  PrimaryKeyBuilder,
  boolean,
  uuid,
  check,
  bigserial,
} from 'drizzle-orm/pg-core';

export const eventOutboxSeq = pgSequence('event_outbox_seq');

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
    seq: bigint({ mode: 'number' }).default(sql`nextval('event_outbox_seq')`),
    publishedAt: timestamp({ withTimezone: true }),
    claimedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('event_outbox_pending_idx').on(t.publishedAt, t.occurredAt)],
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;

export const auditOutbox = pgTable('audit_outbox', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  eventId: uuid().notNull().unique('audit_outbox_event_id_unique'),
  entry: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const auditOutboxRejected = pgTable('audit_outbox_rejected', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  outboxId: bigint({ mode: 'number' }).notNull().unique('audit_outbox_rejected_outbox_id_unique'),
  eventId: uuid().notNull(),
  entry: jsonb().notNull(),
  error: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull(),
  rejectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const openoraInstance = pgTable(
  'openora_instance',
  {
    singleton: boolean().primaryKey().default(true),
    instanceId: uuid().notNull().defaultRandom(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('openora_instance_singleton', sql`${t.singleton}`)],
);

export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: text().notNull(),
    consumer: text().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    new PrimaryKeyBuilder([t.eventId, t.consumer]),
    index('processed_events_processed_at_idx').on(t.processedAt),
  ],
);
