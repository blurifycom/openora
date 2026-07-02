import { oc } from '@orpc/contract';
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

export const AuditActorTypeSchema = z.enum(['player', 'admin', 'system']);

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

export const AuditListFiltersSchema = PageQuerySchema.extend({
  actorId: z.string().optional(),
  actorType: AuditActorTypeSchema.optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  // Single search box: exact-match the subject against actorId OR resourceId.
  q: z.string().trim().min(1).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export const AuditExportFiltersSchema = AuditListFiltersSchema.omit({ page: true, limit: true });

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
