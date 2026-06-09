import type { DrizzleService } from '@oss/db';
import { eq } from 'drizzle-orm';
import { user } from '@oss/modules/platform/identity/schema';

// Resolves the request's tenant server-side from the authenticated user - never
// from a client-supplied header (ADR-0018). The caller is identified by the
// `x-user-id` header (the same seam getUserId reads); the tenant is then looked up
// on the `user` table via the BYPASSRLS admin db (the `user` table is not RLS-
// scoped, and we must read it before a tenant context exists).
//
// Returns undefined for unauthenticated/unknown callers - those requests run with
// NO tenant GUC, so the RLS app role sees zero rows (fail-closed) on any scoped
// table. Public/auth routes that legitimately have no user still work because they
// only touch non-scoped tables (user/session/account) on the admin path.

export interface ResolvedTenant {
  userId: string;
  tenantId: string;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function resolveTenantFromRequest(
  drizzle: DrizzleService,
  headers: Record<string, string | string[] | undefined>,
): Promise<ResolvedTenant | undefined> {
  const userId = firstHeader(headers['x-user-id']);
  if (!userId) return undefined;

  // Admin (BYPASSRLS) db: the `user` table is not tenant-scoped and must be read
  // before any tenant GUC is set.
  const rows = await drizzle.adminDb
    .select({ tenantId: user.tenantId })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const tenantId = rows[0]?.tenantId;
  if (!tenantId) return undefined;
  return { userId, tenantId };
}
