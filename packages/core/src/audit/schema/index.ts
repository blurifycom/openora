import {
  pgTable,
  uuid,
  pgEnum,
  text,
  timestamp,
  jsonb,
  index,
  bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ACTOR_TYPES } from '../contract/index.js';

// Derives from the contract tuple so the Zod schema and DB enum can never drift.
export const actorTypeEnum = pgEnum('audit_actor_type', ACTOR_TYPES);

// Append-only hash-chained audit log. Do NOT expose update/delete routes.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    actorId: text(),
    actorType: actorTypeEnum().notNull(),
    action: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text(),
    before: jsonb().$type<Record<string, unknown>>(),
    after: jsonb().$type<Record<string, unknown>>(),
    ip: text(),
    userAgent: text(),
    correlationId: text(),
    result: text(),
    seq: bigserial({ mode: 'number' }).notNull(),
    prevHash: text(),
    hash: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The `audit_outbox` entry this row was shipped from; null on rows written before the outbox.
    eventId: uuid(),
  },
  (t) => [
    index('audit_log_actor_id_idx').on(t.actorId),
    index('audit_log_resource_id_idx').on(t.resourceId),
    index('audit_log_after_user_id_idx').on(sql`(${t.after}->>'userId')`),
    index('audit_log_action_idx').on(t.action),
    index('audit_log_resource_type_idx').on(t.resourceType),
    index('audit_log_created_at_idx').on(t.createdAt),
    // Kept until every deployment has built the unique `audit_log_seq_key`: dropped in the same
    // migrate run, the chain head lookup would scan the table while that index builds.
    // ponytail: drop it in the next minor, once `audit_log_seq_key` exists everywhere.
    index('audit_log_seq_idx').on(t.seq),
    // The two email-change indexes and the unique seq, prev_hash and event_id indexes are built
    // concurrently by migrate.ts, outside the schema.
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;

// The comment split `migrate` leaves on the main database's outbox guard, so migrate, the shipper
// and a single-database migrate can tell a main database whose chain moved out from one whose chain
// it still holds. Here, not in migrate.ts, so the shipper reads it without the migrate runner.
export const CHAIN_SPLIT_MARK = 'audit chain in a database of its own';

/** One row, `split`: true once split `migrate` has run against this database. */
export const CHAIN_SPLIT_SQL = `SELECT coalesce(obj_description(
     to_regprocedure('audit_outbox_deny_unshipped_delete()'), 'pg_proc') = '${CHAIN_SPLIT_MARK}',
   false) AS split`;
