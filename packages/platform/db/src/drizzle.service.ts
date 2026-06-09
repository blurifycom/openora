import { createToken, type Token } from '@oss/adapters';
import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { getRequestDb, runWithTenantConnection } from './tenant-connection.js';

export const DRIZZLE: Token<DrizzleService> = createToken('DRIZZLE');

/**
 * The two connection paths for RLS tenant isolation (ADR-0018):
 *
 * - `appPool` uses DATABASE_URL, which in production points at an RLS-ENFORCED
 *   role (not superuser, not BYPASSRLS). Per-request traffic runs here, pinned to
 *   a tenant via runWithTenant(). With FORCE ROW LEVEL SECURITY the policy applies
 *   even to the table owner, so RLS is exercised in local/CI single-role setups too.
 * - `adminPool` uses DATABASE_ADMIN_URL (falls back to DATABASE_URL), which in
 *   production points at a BYPASSRLS role for system paths: the outbox relay, seed,
 *   migrations, and backoffice cross-tenant queries. It never sets app.tenant_id.
 *
 * `db` is a tenant-aware facade: when a request has pinned a tenant connection (via
 * runWithTenant -> AsyncLocalStorage), every query routes to that one client; with
 * no pinned connection it uses the app pool directly. System code that must cross
 * tenants resolves `adminDb` explicitly instead.
 */
export class DrizzleService {
  private readonly appPool: Pool;
  private readonly adminPool: Pool;
  private readonly appDb: NodePgDatabase;
  /** Cross-tenant system db (BYPASSRLS role). Never sets app.tenant_id. */
  readonly adminDb: NodePgDatabase;
  /** Tenant-aware db facade. Routes to the request-pinned client when present. */
  readonly db: NodePgDatabase;

  constructor() {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required');
    // DATABASE_ADMIN_URL is the BYPASSRLS role. Local dev/CI commonly run a single
    // superuser role - falling back to DATABASE_URL keeps those setups working;
    // FORCE ROW LEVEL SECURITY still makes the app path enforce RLS there.
    const adminUrl = process.env['DATABASE_ADMIN_URL'] ?? url;

    this.appPool = new Pool({ connectionString: url });
    this.adminPool = new Pool({ connectionString: adminUrl });
    this.appDb = drizzle(this.appPool);
    this.adminDb = drizzle(this.adminPool);

    // The facade proxies query methods to the request-pinned db when one exists,
    // otherwise to the pool-backed app db. Read on every access so concurrent
    // requests each see their own pinned client (the store is request-scoped).
    const resolve = (): NodePgDatabase => getRequestDb()?.db ?? this.appDb;
    this.db = new Proxy(this.appDb, {
      get(_target, prop, receiver) {
        const active = resolve();
        const value = Reflect.get(active as object, prop, receiver);
        return typeof value === 'function' ? value.bind(active) : value;
      },
    });

    // Boot-time RLS guard (ADR-0018, W2): warn loudly if the app pool's role
    // bypasses RLS (superuser or BYPASSRLS). Local/CI commonly run a single
    // superuser owner where this is expected, so we WARN rather than hard-fail -
    // but production MUST point DATABASE_URL at the plain `oss_app` role or tenant
    // isolation is silently inert. Fire-and-forget so construction stays sync.
    void this.assertAppRoleEnforcesRls();
  }

  /**
   * Probe the app pool's current role. If it is a superuser or has BYPASSRLS,
   * RLS does not bite for per-request traffic - log an explicit warning.
   */
  private async assertAppRoleEnforcesRls(): Promise<void> {
    try {
      const result = await this.appDb.execute<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        sql`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      const row = result.rows[0];
      if (!row) return;
      if (row.rolsuper || row.rolbypassrls) {
        process.stderr.write(
          `[RLS WARNING] DATABASE_URL connects as "${row.current_user}" which is ` +
            `${row.rolsuper ? 'a SUPERUSER' : 'BYPASSRLS'} - Postgres Row-Level Security ` +
            `tenant isolation (ADR-0018) is BYPASSED for all per-request traffic. This is ` +
            `acceptable only for local/CI single-role setups. Production MUST point ` +
            `DATABASE_URL at the non-superuser, non-BYPASSRLS "oss_app" role.\n`,
        );
      }
    } catch {
      // A probe failure must never block boot; RLS correctness is enforced by the
      // policies themselves, this is only an operator-facing safety net.
    }
  }

  /** Check out a client from the app (RLS) pool - used by runWithTenant. */
  acquireAppClient(): Promise<PoolClient> {
    return this.appPool.connect();
  }

  /**
   * Run `fn` with a request-scoped client from the app pool pinned to `tenantId`.
   * All `this.db` queries inside `fn` are tenant-scoped by RLS; the GUC is reset
   * and the client released in a finally (leak-safe). See tenant-connection.ts.
   */
  runWithTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenantConnection(() => this.acquireAppClient(), tenantId, fn);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.appPool.end(), this.adminPool.end()]);
  }
}
