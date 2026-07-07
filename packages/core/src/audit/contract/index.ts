import { oc } from '@orpc/contract';
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

// The value tuple is the single source of truth: `z.enum` derives the contract here
// and the Drizzle `pgEnum` in audit/schema derives the DB enum from the same tuple,
// so the two can never drift.
export const ACTOR_TYPES = ['player', 'admin', 'system'] as const;
export const AuditActorTypeSchema = z.enum(ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

// before/after are jsonb snapshots and may hold an object OR an array (eg a role's
// permission list), so allow both - constraining to a record 500s the list output
// validation whenever an array snapshot exists.
const AuditSnapshotSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullable();

export const AuditLogEntrySchema = z.object({
  id: UuidSchema,
  actorId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  before: AuditSnapshotSchema,
  after: AuditSnapshotSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  correlationId: z.string().nullable(),
  result: z.string().nullable(),
  seq: z.number(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: TimestampSchema,
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditListFiltersSchema = PageQuerySchema.extend({
  actorId: z.string().optional(),
  actorType: AuditActorTypeSchema.optional(),
  action: z.string().optional(),
  // Prefix match on action (eg 'rg.' for the RG activity log / change history).
  actionPrefix: z.string().trim().min(1).optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  // Single search box: exact-match the subject against actorId OR resourceId.
  q: z.string().trim().min(1).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});
export type AuditListFilters = z.infer<typeof AuditListFiltersSchema>;

export const AuditExportFiltersSchema = AuditListFiltersSchema.omit({ page: true, limit: true });
export type AuditExportFilters = z.infer<typeof AuditExportFiltersSchema>;

export const auditContract = {
  list: oc
    .route({ method: 'GET', path: '/audit/logs' })
    .input(AuditListFiltersSchema)
    .output(paginated(AuditLogEntrySchema)),

  exportCsv: oc
    .route({ method: 'GET', path: '/audit/export' })
    .input(AuditExportFiltersSchema)
    .output(z.object({ csv: z.string() })),
};
