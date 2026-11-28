import { ORPCError } from '@orpc/server';
import type { McpIamRequirement } from '@openora/core/contracts';
import type { AdminGuard } from '../auth/admin-guard.js';
import type { McpAuthorization } from './kernel.js';

const DENIAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

export async function authorizeWithAdminGuard(
  guard: Pick<AdminGuard, 'assertUser'>,
  adminId: string,
  iam: McpIamRequirement,
): Promise<McpAuthorization> {
  try {
    await guard.assertUser(adminId, iam.resource, iam.action);
    return 'allowed';
  } catch (err) {
    if (err instanceof ORPCError && DENIAL_STATUSES.has(err.status)) {
      return 'denied';
    }
    throw err;
  }
}
