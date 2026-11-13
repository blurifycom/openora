import {
  AUDIT_DRIZZLE,
  AUDIT_SHIPPER_DRIZZLE,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { drainAuditOutbox } from '@openora/core/audit/server';

/**
 * Ships every audit record queued so far into `audit_log`, so a test can read the log straight
 * after the write that queued it. Waits for a running shipper rather than racing it. The chain
 * lands in its own database, shipped as the shipper role, when the app has one.
 */
export function flushAudit({ container }: { container: Container<CoreTokenCatalog> }) {
  if (!container.has(AUDIT_DRIZZLE)) {
    return drainAuditOutbox(container.get(DRIZZLE).db);
  }
  return drainAuditOutbox(container.get(AUDIT_SHIPPER_DRIZZLE).db, container.get(AUDIT_DRIZZLE).db);
}
