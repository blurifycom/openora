import { ORPCError } from '@orpc/server';
import {
  createToken,
  AuthGuardReasonSchema,
  RATE_LIMIT_KEYS,
  makeRateLimitKey,
  type Token,
  type AdminPermissionResolver,
  type AdminGrant,
  type ClientMeta,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { DrizzleService } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { SessionResolver } from './session-resolver.js';
import { statement, roles, type ResourceName, type ActionOf } from './permissions.js';
import { levelToActions, type PermissionLevel } from './permission-levels.js';
import type { OssContext, EventBus } from '../kernel/index.js';
import { extractClientMeta } from '../kernel/router-utils.js';

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

export type AdminCaller = { userId: string; role: string } & ClientMeta;

const DENIED_ACCESS_THROTTLE_MS = 60_000;

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
    // Throttles recordDeniedAccess(); unbound just means no throttling (best-effort).
    private readonly rateLimiter?: RateLimiterAdapter<RateLimitKey>,
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

  async recordDeniedAccess(
    caller: AdminCaller,
    resource: string,
    level: PermissionLevel,
  ): Promise<{ recorded: boolean }> {
    const knownActions = statement[resource as ResourceName] as readonly string[] | undefined;
    if (!knownActions) {
      throw new ORPCError('BAD_REQUEST', { message: `Unknown resource: ${resource}` });
    }
    if (level === 'no_access') {
      throw new ORPCError('BAD_REQUEST', { message: 'level must not be no_access' });
    }
    // levelToActions('read') on a view-less module (eg `content`) is deliberately []
    // (see permission-levels.ts) - fall back to the full action set rather than
    // treating that as "nothing to check", which would wrongly no-op the report.
    const derivedActions = levelToActions(resource, level);
    const actions = derivedActions.length > 0 ? derivedActions : knownActions;

    const userRole = roles[caller.role as keyof typeof roles];
    // Fresh (uncached) grants: a cached `getGrants` could still reflect the
    // pre-grant state for up to its TTL, which would let a caller who was JUST
    // given this permission report a denial it no longer has - self-forging a
    // false audit entry in the gap before the cache purge lands.
    const grants = await this.resolveFreshGrants(caller.userId);
    const missingAction = actions.find(
      (action) => !this.checkGrant(grants, userRole, resource, action),
    );
    if (!missingAction) {
      return { recorded: false };
    }

    if (this.rateLimiter) {
      const key = makeRateLimitKey(
        RATE_LIMIT_KEYS.ACCESS_DENIED_REPORT,
        `${caller.userId}:${resource}:${level}`,
      );
      const { allowed } = await this.rateLimiter.consume(key, {
        limit: 1,
        windowMs: DENIED_ACCESS_THROTTLE_MS,
      });
      if (!allowed) {
        return { recorded: false };
      }
    }

    this.emitUnauthorized(
      caller.userId,
      caller.role,
      resource,
      missingAction,
      caller.ip,
      caller.userAgent,
    );
    return { recorded: true };
  }

  private resolveGrants(userId: string): Promise<AdminGrant[] | null> {
    return this.permissionResolver
      ? this.permissionResolver.getGrants(userId)
      : Promise.resolve(null);
  }

  private resolveFreshGrants(userId: string): Promise<AdminGrant[] | null> {
    if (!this.permissionResolver) {
      return Promise.resolve(null);
    }
    return this.permissionResolver.getFreshGrants
      ? this.permissionResolver.getFreshGrants(userId)
      : this.permissionResolver.getGrants(userId);
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
