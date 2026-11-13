import {
  AUDIT_DRIZZLE,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { drainAuditOutbox } from '@openora/core/audit/server';

/**
 * Ships every audit record queued so far into `audit_log`, so a test can read the log straight
 * after the write that queued it. Waits for a running shipper rather than racing it. The chain
 * lands in its own database when the app has one.
 */
export function flushAudit({ container }: { container: Container<CoreTokenCatalog> }) {
  const chain = container.has(AUDIT_DRIZZLE) ? container.get(AUDIT_DRIZZLE).db : undefined;
  return drainAuditOutbox(container.get(DRIZZLE).db, chain);
}
