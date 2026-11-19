import {
  ADMIN_PERMISSION_ROUTES,
  AdminPermissionWire,
  type AdminGrant,
  type AdminPermissionResolver,
  type Uuid,
} from '@openora/core/contracts';
import { upstreamDownAs503, type InternalClient } from '@openora/core/server';

/**
 * {@link AdminPermissionResolver} answered by the service that owns the role assignments, for a
 * service whose database has none. Never cached here: the owner caches for seconds and purges on
 * every grant change, and a copy on this side would add its own staleness to a revoked admin's
 * access. A call that fails throws (503 when the owner is unreachable) and never reads as "no
 * grants": the guard refuses the request either way, and a transient failure is not recorded as
 * a denial.
 */
export class RemoteAdminPermissionResolver implements AdminPermissionResolver {
  constructor(private readonly client: InternalClient) {}

  async getGrants(userId: Uuid): Promise<AdminGrant[]> {
    const { grants } = await this.ask(ADMIN_PERMISSION_ROUTES.grants, AdminPermissionWire.grants, {
      userId,
    });
    return grants;
  }

  async isSuperAdmin(userId: Uuid): Promise<boolean> {
    const { isSuperAdmin } = await this.ask(
      ADMIN_PERMISSION_ROUTES.superAdmin,
      AdminPermissionWire.superAdmin,
      { userId },
    );
    return isSuperAdmin;
  }

  private async ask<O>(
    route: string,
    wire: { output: { parse(value: unknown): O } },
    body: { userId: Uuid },
  ): Promise<O> {
    try {
      return wire.output.parse(await this.client.request('POST', route, body));
    } catch (err) {
      throw upstreamDownAs503(err);
    }
  }
}
