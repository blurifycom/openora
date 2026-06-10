import { oc } from '@orpc/contract';
import * as z from 'zod';

// --- Output shapes ---

export const AuditActorTypeSchema = z.enum(['player', 'admin', 'system']);

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
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
  seq: z.number(),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: z.string(),
});

// --- Input shapes ---

export const AuditListFiltersSchema = z.object({
  actorId: z.string().optional(),
  actorType: AuditActorTypeSchema.optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(50),
});

export const AuditExportFiltersSchema = AuditListFiltersSchema.omit({ page: true, limit: true });

// --- Contract ---

export const auditContract = {
  list: oc
    .route({ method: 'GET', path: '/audit/logs' })
    .input(AuditListFiltersSchema)
    .output(
      z.object({
        items: z.array(AuditLogEntrySchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
    ),

  exportCsv: oc
    .route({ method: 'GET', path: '/audit/export' })
    .input(AuditExportFiltersSchema)
    .output(z.object({ csv: z.string() })),
};
