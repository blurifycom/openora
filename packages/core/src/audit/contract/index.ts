import { oc } from '@orpc/contract';
import * as z from 'zod';
import { PageQuerySchema, paginated } from '@oss/core/contracts/kit';

// --- Output shapes ---

export const AuditActorTypeSchema = z.enum(['player', 'admin', 'system']);

export const AuditLogEntrySchema = z.object({
  id: z.uuid(),
  actorId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  correlationId: z.string().nullable(),
  result: z.string().nullable(),
  seq: z.number(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: z.iso.datetime(),
});

// --- Input shapes ---

export const AuditListFiltersSchema = PageQuerySchema.extend({
  actorId: z.string().optional(),
  actorType: AuditActorTypeSchema.optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export const AuditExportFiltersSchema = AuditListFiltersSchema.omit({ page: true, limit: true });

// --- Contract ---

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
