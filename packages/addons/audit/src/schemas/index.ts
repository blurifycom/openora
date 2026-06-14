export {
  auditContract,
  AuditLogEntrySchema,
  AuditActorTypeSchema,
  AuditListFiltersSchema,
  AuditExportFiltersSchema,
} from '../contract/index.js';
import type { z } from 'zod';
import type {
  AuditLogEntrySchema,
  AuditActorTypeSchema,
  AuditListFiltersSchema,
  AuditExportFiltersSchema,
} from '../contract/index.js';

export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
export type AuditListFilters = z.infer<typeof AuditListFiltersSchema>;
export type AuditExportFilters = z.infer<typeof AuditExportFiltersSchema>;
