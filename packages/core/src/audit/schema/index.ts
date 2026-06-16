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

export const actorTypeEnum = pgEnum('audit_actor_type', ['player', 'admin', 'system']);

// Append-only tamper-evident audit log. Hash-chained per tenant.
// Do NOT expose update/delete routes - this table is write-once.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenantId').notNull(),
    actorId: text('actorId'),
    actorType: actorTypeEnum('actorType').notNull(),
    action: text('action').notNull(),
    resourceType: text('resourceType').notNull(),
    resourceId: text('resourceId'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('userAgent'),
    correlationId: text('correlationId'),
    // Action outcome (e.g. 'success' | 'failure'). Nullable for older rows.
    // NOT part of the hash chain (like ip/before/after), so adding it does not
    // break existing rows' tamper-evidence hashes.
    result: text('result'),
    // bigserial gives a monotonically increasing per-DB sequence; used for ordering.
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    prevHash: text('prevHash'),
    hash: text('hash').notNull(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tenantId_idx').on(t.tenantId),
    index('audit_log_actorId_idx').on(t.actorId),
    index('audit_log_action_idx').on(t.action),
    index('audit_log_resourceType_idx').on(t.resourceType),
    index('audit_log_createdAt_idx').on(t.createdAt),
    index('audit_log_tenant_seq_idx').on(t.tenantId, t.seq),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
