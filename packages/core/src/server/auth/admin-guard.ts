import { ORPCError } from '@orpc/server';
import {
  createToken,
  AuthGuardReasonSchema,
  type Token,
  type AdminPermissionResolver,
  type AdminGrant,
  type IdentityReader,
  type ClientMeta,
} from '@openora/core/contracts';
import { DrizzleService } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { SessionResolver } from './session-resolver.js';
import { roles, type ResourceName, type ActionOf } from './permissions.js';
import type { OssContext, EventBus } from '../kernel/index.js';
import { createLogger } from '../kernel/logger.js';
import { extractClientMeta } from '../kernel/router-utils.js';

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

const logger = createLogger('admin-guard');

export type AdminCaller = { userId: string; role: string } & ClientMeta;

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
    // When bound (identity module loaded), resolves the PAM player.id for a
    // player-role denial's audit attribution. This engine-zone file must not import
    // the player schema directly (ADR-0019/0025), so it goes through this port instead.
    private readonly identityReader?: IdentityReader,
  ) {}

  async assert(context: unknown): Promise<AdminCaller>;
  async assert<R extends ResourceName>(
    context: unknown,
    resource: R,
    action: ActionOf<R>,
  ): Promise<AdminCaller>;
  async assert<R extends ResourceName>(
    context: unknown,
    resource?: R,
    action?: ActionOf<R>,
  ): Promise<AdminCaller> {
    const request = (context as { request?: OssContext['request'] }).request;
    if (!request || typeof request.headers !== 'object') {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Missing request context',
        data: { reason: AuthGuardReasonSchema.enum.missing_request_context },
      });
    }

    const { ip, userAgent } = extractClientMeta(request.headers);

    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) {
      if (v === undefined) {
        continue;
      }
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const userId = await this.sessions.resolveUserId(headers);
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Authentication required',
        data: { reason: AuthGuardReasonSchema.enum.authentication_required },
      });
    }

    const result = await this.drizzle.db.execute(
      sql`SELECT id, role FROM "user" WHERE id = ${userId} LIMIT 1`,
    );
    const userRecord = result.rows[0] as { id: string; role: string } | undefined;
    if (!userRecord) {
      if (resource !== undefined && action !== undefined) {
        this.emitUnauthorized(userId, undefined, resource, action, ip, userAgent);
      } else {
        this.emitUnauthorized(userId, undefined, 'admin', 'access', ip, userAgent);
      }
      throw new ORPCError('FORBIDDEN', {
        message: 'Admin access required',
        data: { reason: AuthGuardReasonSchema.enum.admin_required },
      });
    }

    const userRole = roles[userRecord.role as keyof typeof roles];
    if (!userRole) {
      if (resource !== undefined && action !== undefined) {
        this.emitUnauthorized(userId, userRecord.role, resource, action, ip, userAgent);
      } else {
        this.emitUnauthorized(userId, userRecord.role, 'admin', 'access', ip, userAgent);
      }
      throw new ORPCError('FORBIDDEN', {
        message: 'Admin access required',
        data: { reason: AuthGuardReasonSchema.enum.admin_required },
      });
    }

    if (resource !== undefined && action !== undefined) {
      const grants = await this.resolveGrants(userId);
      const allowed = this.checkGrant(grants, userRole, resource, action);
      if (!allowed) {
        this.emitUnauthorized(userId, userRecord.role, resource, action, ip, userAgent);
        throw new ORPCError('FORBIDDEN', {
          message: `Missing permission: ${String(resource)}:${String(action)}`,
          data: {
            reason: AuthGuardReasonSchema.enum.permission_denied,
            resource: String(resource),
            action: String(action),
          },
        });
      }
    }

    return { userId, role: userRecord.role, ip, userAgent };
  }

  async assertSuperAdmin(context: unknown): Promise<AdminCaller> {
    const caller = await this.assert(context);
    const assigned = await this.permissionResolver?.isSuperAdmin(caller.userId);
    const isSuper = assigned ?? caller.role === 'admin';

    if (!isSuper) {
      this.emitUnauthorized(
        caller.userId,
        caller.role,
        'admin',
        'super-admin',
        caller.ip,
        caller.userAgent,
      );
      throw new ORPCError('FORBIDDEN', {
        message: 'Super admin access required',
        data: { reason: AuthGuardReasonSchema.enum.admin_required },
      });
    }
    return caller;
  }

  private resolveGrants(userId: string): Promise<AdminGrant[] | null> {
    return this.permissionResolver
      ? this.permissionResolver.getGrants(userId)
      : Promise.resolve(null);
  }

  private checkGrant(
    grants: AdminGrant[] | null,
    userRole: (typeof roles)[keyof typeof roles] | undefined,
    resource: string,
    action: string,
  ): boolean {
    if (grants !== null) {
      return grants.some((g) => g.resource === resource && g.action === action);
    }
    return userRole?.authorize({ [resource]: [action] }).success ?? false;
  }

  private emitUnauthorized(
    userId: string,
    role: string | undefined,
    resource: string,
    action: string,
    ip: string | null,
    userAgent: string | null,
  ) {
    void (async () => {
      const playerId =
        role === 'player'
          ? ((await this.identityReader?.getPlayerIdByUserIdSafe(userId)) ?? null)
          : null;
      try {
        this.events?.emit('identity.user.unauthorized_access', {
          userId,
          playerId,
          resource,
          action,
          ip,
          userAgent,
          role,
        });
      } catch (err) {
        logger.error({ err, userId, resource, action }, 'denial audit event failed');
      }
    })();
  }
}
