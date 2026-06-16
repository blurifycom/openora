import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

export type DrizzleDb = NodePgDatabase;

export function createDrizzleDb(connectionString?: string): DrizzleDb {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  return drizzle(new Pool({ connectionString: url }));
}

// NOTE: the old `setTenantId(db, id)` that did a session-level `SET app.tenant_id`
// on a pooled connection was REMOVED - it leaked tenant scope onto the next request
// that borrowed that connection from the pool (ADR-0018). Per-request RLS scoping
// now goes through DrizzleService.runWithTenant(tenantId, fn), which pins a single
// checked-out client, sets the GUC on it, and resets + releases it in a finally.
// For a transaction-local scope use `SET LOCAL app.tenant_id` INSIDE db.transaction
// (cleared automatically at commit/rollback) - never a bare session `SET`.
