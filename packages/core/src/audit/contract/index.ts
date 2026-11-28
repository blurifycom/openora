import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  LimitChangeKindSchema,
  LimitPeriodSchema,
  LimitTypeSchema,
  MoneyAmountSchema,
  TimestampSchema,
  UuidSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

export const ACTOR_TYPES = ['player', 'admin', 'system'] as const;
export const AuditActorTypeSchema = z.enum(ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditSnapshotSchema = z
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

export const AUDIT_SORT_BY_VALUES = [
  'createdAt',
  'action',
  'actorId',
  'actorType',
  'resourceType',
  'resourceId',
] as const;
export const AuditSortBySchema = z.enum(AUDIT_SORT_BY_VALUES).default('createdAt');
export type AuditSortBy = z.infer<typeof AuditSortBySchema>;

export const AuditListFiltersSchema = PageQuerySchema.extend({
  actorId: z.string().optional(),
  actorType: AuditActorTypeSchema.optional(),
  action: z.string().optional(),
  actionPrefix: z.string().trim().min(1).optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  q: z.string().trim().min(1).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  sortBy: AuditSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});
export type AuditListFilters = z.infer<typeof AuditListFiltersSchema>;

export const AuditExportFiltersSchema = AuditListFiltersSchema.omit({
  page: true,
  limit: true,
}).extend({
  sortOrder: SortOrderSchema.default('asc').optional(),
});
export type AuditExportFilters = z.infer<typeof AuditExportFiltersSchema>;

export const MyRgHistoryEntrySchema = z.object({
  id: UuidSchema,
  action: z.string(),
  actorType: AuditActorTypeSchema,
  createdAt: TimestampSchema,
  type: LimitTypeSchema.nullable(),
  period: LimitPeriodSchema.nullable(),
  kind: LimitChangeKindSchema.nullable(),
  previousAmount: MoneyAmountSchema.nullable(),
  newAmount: MoneyAmountSchema.nullable(),
  previousMinutes: z.number().int().nullable(),
  newMinutes: z.number().int().nullable(),
  effectiveAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
});
export type MyRgHistoryEntry = z.infer<typeof MyRgHistoryEntrySchema>;

export const MyRgHistoryFiltersSchema = PageQuerySchema.extend({
  sortOrder: SortOrderSchema.default('desc').optional(),
});
export type MyRgHistoryFilters = z.infer<typeof MyRgHistoryFiltersSchema>;

export const auditContract = {
  list: oc
    .route({ method: 'GET', path: '/audit/logs' })
    .input(AuditListFiltersSchema)
    .output(paginated(AuditLogEntrySchema)),

  exportCsv: oc
    .route({ method: 'GET', path: '/audit/export' })
    .input(AuditExportFiltersSchema)
    .output(z.object({ csv: z.string() })),

  listMyRgHistory: oc
    .route({ method: 'GET', path: '/audit/me/rg-history' })
    .input(MyRgHistoryFiltersSchema)
    .output(paginated(MyRgHistoryEntrySchema)),
};
