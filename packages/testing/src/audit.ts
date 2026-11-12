import { DRIZZLE, type Container, type CoreTokenCatalog } from '@openora/core/server';
import { drainAuditOutbox } from '@openora/core/audit/server';

/**
 * Ships every audit record queued so far into `audit_log`, so a test can read the log straight
 * after the write that queued it. Waits for a running shipper rather than racing it.
 */
export function flushAudit({ container }: { container: Container<CoreTokenCatalog> }) {
  return drainAuditOutbox(container.get(DRIZZLE).db);
}
