import type { DrizzleService } from '../db/index.js';
import { eq } from 'drizzle-orm';

// The `user` table this resolver reads: it must expose `id` and `tenantId`
// columns. The engine is domain-agnostic and does not import any domain schema -
// the composition root injects its PAM identity `user` table. See ADR-0024/0025.
// oxlint-disable-next-line typescript/no-explicit-any -- injected drizzle table (external generic shape)
type UserTableLike = any;

// Resolves the request's tenant server-side from the ALREADY-VERIFIED user id
// (ADR-0018/0019). The caller is identified upstream by verifying the better-auth
// session cookie (createApp middleware -> SessionResolver), never from a client
// header. This function only maps that verified userId to its tenant via the
// injected `user` table on the BYPASSRLS admin db (the `user` table is not
// RLS-scoped, and we must read it before a tenant context exists).
//
// Returns undefined when the user has no resolvable tenant - that request runs
// with NO tenant GUC, so the RLS app role sees zero rows (fail-closed) on any
// scoped table.
export async function resolveTenantForUser(
  drizzle: DrizzleService,
  userId: string,
  userTable: UserTableLike,
): Promise<string | undefined> {
  // Admin (BYPASSRLS) db: the `user` table is not tenant-scoped and must be read
  // before any tenant GUC is set.
  const rows = await drizzle.adminDb
    .select({ tenantId: userTable.tenantId })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  return rows[0]?.tenantId;
}
