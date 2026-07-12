import { ORPCError } from '@orpc/server';
import { createToken, type Token, type AdminPermissionResolver } from '@openora/core/contracts';
import { DrizzleService } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { SessionResolver } from './session-resolver.js';
import { roles, type ResourceName, type ActionOf } from './permissions.js';
import type { OssContext, EventBus } from '../kernel/index.js';

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

/**
 * The single admin-enforcement point - every admin route calls `assert()` as its
 * first line, never re-implementing the role check. Overload without
 * `resource`/`action` only requires a valid admin session; the 3-arg overload
 * additionally checks a specific permission. When the iam module's permission
 * resolver is bound, DB-assigned grants are authoritative; when a role has no DB
 * assignment row (the bootstrap path - seed admin), it falls back to the static
 * role table instead of denying outright. A revoked-in-DB but still
 * statically-granted role is NOT denied by this fallback - revoke the static role
 * to fully lock a bootstrap admin out. Every denial emits
 * `identity.user.unauthorized_access` for audit, before throwing.
 */
export class AdminGuard {
  // Uses the shared SessionResolver (one better-auth init for the whole app) rather than a second createAuth over the same DB.
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: SessionResolver,
    // When bound (iam module loaded), grants come from DB; otherwise falls back to static roles.
    private readonly permissionResolver?: AdminPermissionResolver,
    private readonly events?: EventBus,
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
    const request = (context as { request?: OssContext['request'] }).request;
    if (!request || typeof request.headers !== 'object') {
      throw new ORPCError('UNAUTHORIZED', { message: 'Missing request context' });
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) {
        continue;
      }
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
      if (resource !== undefined && action !== undefined) {
        this.emitUnauthorized(userId, undefined, resource, action, headers);
      } else {
        this.emitUnauthorized(userId, undefined, 'admin', 'access', headers);
      }
      throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
    }

    const userRole = roles[userRecord.role as keyof typeof roles];
    if (!userRole) {
      if (resource !== undefined && action !== undefined) {
        this.emitUnauthorized(userId, userRecord.role, resource, action, headers);
      } else {
        this.emitUnauthorized(userId, userRecord.role, 'admin', 'access', headers);
      }
      throw new ORPCError('FORBIDDEN', { message: 'Admin access required' });
    }

    if (resource !== undefined && action !== undefined) {
      const grants = this.permissionResolver
        ? await this.permissionResolver.getGrants(userId)
        : null;

      if (grants !== null) {
        const allowed = grants.some((g) => g.resource === resource && g.action === action);
        if (!allowed) {
          this.emitUnauthorized(userId, userRecord.role, resource, action, headers);
          throw new ORPCError('FORBIDDEN', {
            message: `Missing permission: ${String(resource)}:${String(action)}`,
          });
        }
      } else {
        // Bootstrap path: seed admin has user.role='admin' but no DB assignment row. DB revocation is NOT authoritative while a static role still grants - revoke the static role to fully deny.
        const check = userRole.authorize({ [resource]: [action] });
        if (!check.success) {
          this.emitUnauthorized(userId, userRecord.role, resource, action, headers);
          throw new ORPCError('FORBIDDEN', {
            message: `Missing permission: ${String(resource)}:${String(action)}`,
          });
        }
      }
    }

    return { userId, role: userRecord.role };
  }

  private emitUnauthorized(
    userId: string,
    role: string | undefined,
    resource: string,
    action: string,
    headers: Headers,
  ) {
    const ip =
      headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || null;
    const userAgent = headers.get('user-agent') || null;
    this.events?.emit('identity.user.unauthorized_access', {
      userId,
      resource,
      action,
      ip,
      userAgent,
      role,
    });
  }
}
