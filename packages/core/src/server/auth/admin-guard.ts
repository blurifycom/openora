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
  // Uses the shared SessionResolver (one better-auth init for the whole app) rather than a second createAuth over the same DB.
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: SessionResolver,
    // When bound (iam module loaded), grants come from DB; otherwise falls back to static roles.
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
    console.log(headers); // NOT FOR DEV
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
        const allowed = grants.some((g) => g.resource === resource && g.action === action);
        if (!allowed) {
          throw new ORPCError('FORBIDDEN', {
            message: `Missing permission: ${String(resource)}:${String(action)}`,
          });
        }
      } else {
        // Bootstrap path: seed admin has user.role='admin' but no DB assignment row. DB revocation is NOT authoritative while a static role still grants - revoke the static role to fully deny.
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
      if (!roles[userRecord.role as keyof typeof roles]) {
        throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
      }
    }

    return { userId, role: userRecord.role };
  }
}
