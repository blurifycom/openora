import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

// Request-scoped DB binding for Postgres Row-Level Security (RLS).
//
// The pg Pool hands out arbitrary connections and the DrizzleService.db singleton
// is shared across concurrent requests, so a session-level `SET app.tenant_id`
// would leak the tenant scope onto whatever request next borrows that connection.
// This module pins ONE checked-out client per request, sets the tenant GUC on it,
// routes every query of that request to it, and provably resets + releases it in a
// `finally`. The pinned db is published through an AsyncLocalStorage so existing
// singleton services calling `this.drizzle.db` transparently get the tenant-scoped
// connection without any signature change (DrizzleService.db reads this store).
//
// Leak-safety invariant: a client returned to the pool must NEVER carry a residual
// `app.tenant_id`. See ADR-0018.

export interface PinnedDb {
  /** The tenant whose GUC is set on the pinned client. */
  tenantId: string;
  /** Drizzle bound to the single pinned client (not the pool). */
  db: NodePgDatabase;
}

const requestDbStorage = new AsyncLocalStorage<PinnedDb>();

/** The pinned tenant-scoped db for the current request, if any. */
export function getRequestDb(): PinnedDb | undefined {
  return requestDbStorage.getStore();
}

/**
 * Run `fn` with a dedicated client checked out from `pool`, pinned to `tenantId`
 * via `SET app.tenant_id`. Every query inside `fn` that resolves the db through
 * `getRequestDb()` (ie via DrizzleService.db) runs on that one client, so the
 * RLS policy `"tenantId" = current_setting('app.tenant_id', true)` filters it.
 *
 * The client is reset and released in `finally` whether `fn` resolves or throws.
 * `RESET app.tenant_id` clears the GUC before the client re-enters the pool; the
 * release is guarded so a reset failure still returns the client (destroyed) and
 * never strands the pool. This is why a pooled connection cannot carry a residual
 * tenant GUC across requests.
 */
export async function runWithTenantConnection<T>(
  acquire: () => Promise<PoolClient>,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await acquire();
  const db = drizzle(client);
  try {
    // missing_ok=false is fine here - we are explicitly setting it. Parameterized
    // via set_config so a hostile tenantId string cannot break out of the SET.
    await db.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, false)`);
    return await requestDbStorage.run({ tenantId, db }, fn);
  } finally {
    // Clear the GUC BEFORE the client goes back to the pool. If the reset itself
    // fails (broken connection), destroy the client (release(true)) so a dirty
    // connection is never reused - fail-closed.
    try {
      await db.execute(sql`SELECT set_config('app.tenant_id', '', false)`);
      client.release();
    } catch {
      client.release(true);
    }
  }
}
