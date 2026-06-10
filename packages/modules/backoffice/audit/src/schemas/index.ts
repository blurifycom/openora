export {
  auditContract,
  AuditLogEntrySchema,
  AuditActorTypeSchema,
  AuditListFiltersSchema,
  AuditExportFiltersSchema,
} from '@oss/orpc-contract/audit';
import type { z } from 'zod';
import type {
  AuditLogEntrySchema,
  AuditActorTypeSchema,
  AuditListFiltersSchema,
  AuditExportFiltersSchema,
} from '@oss/orpc-contract/audit';

export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
export type AuditListFilters = z.infer<typeof AuditListFiltersSchema>;
export type AuditExportFilters = z.infer<typeof AuditExportFiltersSchema>;
