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
  // external / system actor id - not necessarily one of our UUIDs
  actorId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  action: z.string(),
  resourceType: z.string(),
  // arbitrary resource key (config key, external ref, ...) - not necessarily a UUID
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
  // Prefix match on action (eg 'rg.' for the RG activity log / change history).
  actionPrefix: z.string().trim().min(1).optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  // Single search box: exact-match the subject against actorId OR resourceId.
  q: z.string().trim().min(1).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
  sortBy: AuditSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});
export type AuditListFilters = z.infer<typeof AuditListFiltersSchema>;

// Export inherits sortBy/sortOrder from the list schema; override default sort order to
// ascending (chronological) to match prior exportCsv behaviour (asc by seq).
export const AuditExportFiltersSchema = AuditListFiltersSchema.omit({
  page: true,
  limit: true,
}).extend({
  sortOrder: SortOrderSchema.default('asc').optional(),
});
export type AuditExportFilters = z.infer<typeof AuditExportFiltersSchema>;

// Player self-service history. This is a hand-picked field ALLOWLIST, not a redaction
// of AuditLogEntrySchema - the RG event payload stored in `after` also carries an
// admin's mandatory `reason`, the acting admin's `actorId`, request `ip`/`userAgent`/
// `correlationId` (via `actorReasonBase`/`authContextBase`, see contracts/schemas/events.ts),
// and AuditLogEntrySchema itself exposes `seq`/`hash`/`prevHash` which leak the hash-chain
// structure. None of that may reach a player. A newly added `rg.limit.*` topic surfaces
// NOTHING on this route until its payload is reviewed and its fields are named here.
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

// Pagination only - the caller can never pass actorId/resourceType/resourceId/
// actionPrefix/q. The subject and the `rg.limit.` prefix are forced server-side.
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
