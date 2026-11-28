import {
  AUDIT_DRIZZLE,
  AUDIT_SHIPPER_DRIZZLE,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { drainAuditOutbox } from '@openora/core/audit/server';

export function flushAudit({ container }: { container: Container<CoreTokenCatalog> }) {
  if (!container.has(AUDIT_DRIZZLE)) {
    return drainAuditOutbox(container.get(DRIZZLE).db);
  }
  return drainAuditOutbox(container.get(AUDIT_SHIPPER_DRIZZLE).db, container.get(AUDIT_DRIZZLE).db);
}
