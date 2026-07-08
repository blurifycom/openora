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
  },
  (t) => [
    index('audit_log_actor_id_idx').on(t.actorId),
    index('audit_log_resource_id_idx').on(t.resourceId),
    index('audit_log_action_idx').on(t.action),
    index('audit_log_resource_type_idx').on(t.resourceType),
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_seq_idx').on(t.seq),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
