import { ORPCError } from '@orpc/server';
import {
  createToken,
  type Token,
  type AdminPermissionResolver,
} from '../../contracts/adapters/index.js';
import { DrizzleService } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { SessionResolver } from './session-resolver.js';
import { roles, type ResourceName, type ActionOf } from './permissions.js';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

export class AdminGuard {
  // The guard verifies the session through the SHARED SessionResolver (one
  // better-auth init for the whole app) rather than building a second createAuth
  // over the same DB. createApp binds both the resolver and the guard.
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: SessionResolver,
    // Optional DB-backed RBAC. When bound (the iam module is loaded), effective
    // grants come from the DB; otherwise the guard falls back to static roles.
    private readonly permissionResolver?: AdminPermissionResolver,
  ) {}

  async assert(context: unknown): Promise<{ userId: string; role: string }>;
  async assert<R extends ResourceName>(
    context: unknown,
    resource: R,
    action: ActionOf<R>,
  ): Promise<{ userId: string; role: string }>;
  async assert<R extends ResourceName>(
    context: unknown,
    resource?: R,
    action?: ActionOf<R>,
  ): Promise<{ userId: string; role: string }> {
    const request = (context as { request?: RequestLike }).request;
    if (!request || typeof request.headers !== 'object') {
      throw new ORPCError('UNAUTHORIZED', { message: 'Missing request context' });
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }

    const userId = await this.sessions.resolveUserId(headers);
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
    }

    const result = await this.drizzle.db.execute(
      sql`SELECT id, role FROM "user" WHERE id = ${userId} LIMIT 1`,
    );
    const userRecord = result.rows[0] as { id: string; role: string } | undefined;
    if (!userRecord) {
      throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
    }

    if (resource !== undefined && action !== undefined) {
      const grants = this.permissionResolver
        ? await this.permissionResolver.getGrants(userId)
        : null;

      if (grants !== null) {
        // DB-backed role assignment present - authorize against the grants.
        const allowed = grants.some((g) => g.resource === resource && g.action === action);
        if (!allowed) {
          throw new ORPCError('FORBIDDEN', {
            message: `Missing permission: ${String(resource)}:${String(action)}`,
          });
        }
      } else {
        // No DB role (or no resolver bound) - fall back to static roles.
        // INTENTIONAL bootstrap path: the seed/bootstrap admin has user.role='admin'
        // but no DB assignment row and must not be locked out. As a consequence, DB
        // revocation is NOT authoritative while a static admin role still grants the
        // permission - revoke the static role to fully deny such a user.
        const userRole = roles[userRecord.role as keyof typeof roles];
        if (!userRole) {
          throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
        }
        const check = userRole.authorize({ [resource]: [action] });
        if (!check.success) {
          throw new ORPCError('FORBIDDEN', {
            message: `Missing permission: ${String(resource)}:${String(action)}`,
          });
        }
      }
    } else {
      // Bare assert (no resource/action): fail closed. Only an entry in the admin
      // allow-list (`roles`) may pass - any other non-null role (player, support
      // with no static admin grant, unknown/empty) is rejected.
      if (!roles[userRecord.role as keyof typeof roles]) {
        throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
      }
    }

    return { userId, role: userRecord.role };
  }
}
