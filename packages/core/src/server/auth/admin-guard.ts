import { ORPCError } from '@orpc/server';
import {
  createToken,
  AuthGuardReasonSchema,
  type Token,
  type AdminPermissionResolver,
  type AdminGrant,
  type AdminSecurityPolicy,
  type IdentityReader,
  type ClientMeta,
} from '@openora/core/contracts';
import { DrizzleService } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { SessionResolver } from './session-resolver.js';
import { holdsGrant, isRoleName, type ResourceName, type ActionOf } from './permissions.js';
import type { OssContext, EventBus } from '../kernel/index.js';
import { createLogger } from '../kernel/logger.js';
import { extractClientMeta } from '../kernel/router-utils.js';

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

const logger = createLogger('admin-guard');

export type AdminCaller = { userId: string; role: string } & ClientMeta;

type GrantRequirement = { resource: string; action: string };

/**
 * The single admin-enforcement point - every admin route calls `assert()` as its
 * first line, never re-implementing the role check. Overload without
 * `resource`/`action` only requires a valid admin session; the 3-arg overload
 * additionally checks a specific permission. When the iam module's permission
 * resolver is bound, DB-assigned grants are authoritative: an admin with no
 * assigned role (never assigned, or every role revoked) holds no permissions and
 * is not a super admin. Only when no resolver is bound does the static role table
 * decide. Every denial emits `identity.user.unauthorized_access` for audit, before
 * throwing.
 */
export class AdminGuard {
  // Uses the shared SessionResolver (one better-auth init for the whole app) rather than a second createAuth over the same DB.
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: SessionResolver,
    // When bound (iam module loaded), grants come from DB only; otherwise static roles decide.
    private readonly permissionResolver?: AdminPermissionResolver,
    private readonly events?: EventBus,
    // When bound (identity module loaded), resolves the PAM player.id for a
    // player-role denial's audit attribution. This engine-zone file must not import
    // the player schema directly (ADR-0019/0025), so it goes through this port instead.
    private readonly identityReader?: IdentityReader,
    // When bound (identity module loaded), enforces mandatory 2FA enrolment and the
    // session's device fingerprint. Same layering reason as identityReader.
    private readonly securityPolicy?: AdminSecurityPolicy,
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
    const resolvedSession = await this.sessions.resolveSession(headers);
    const userId = resolvedSession?.userId;
    if (!userId) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Authentication required',
        data: { reason: AuthGuardReasonSchema.enum.authentication_required },
      });
    }

    return this.enforce({
      userId,
      clientMeta: { ip, userAgent },
      permission: resource !== undefined && action !== undefined ? { resource, action } : undefined,
      session: { sessionId: resolvedSession?.sessionId ?? null },
    });
  }

  /**
   * `assert` for a caller that is not an HTTP request (an agent run, an MCP token): the same
   * user, role, grant and 2FA-enrolment checks and the same denial event, without a session -
   * so no session-integrity check, and `ip`/`userAgent` are null. A deactivated account is
   * refused too: with no session to revoke, nothing else stops a credential it issued.
   */
  async assertUser<R extends ResourceName>(
    userId: string,
    resource: R,
    action: ActionOf<R>,
  ): Promise<AdminCaller> {
    return this.enforce({
      userId,
      clientMeta: { ip: null, userAgent: null },
      permission: { resource, action },
      requireActive: true,
    });
  }

  /**
   * The requirements `userId` holds, decided as `assertUser` decides but with no denial event
   * and no 2FA check: it narrows what a caller is shown and never authorizes anything.
   */
  async filterGranted<T extends GrantRequirement>(
    userId: string,
    requirements: readonly T[],
  ): Promise<T[]> {
    const { account, granted } = await this.resolveAccess(userId, requirements);
    return account?.isActive && account.isAdmin ? granted : [];
  }

  async assertSuperAdmin(context: unknown): Promise<AdminCaller> {
    const caller = await this.assert(context);
    const isSuper = this.permissionResolver
      ? await this.permissionResolver.isSuperAdmin(caller.userId)
      : caller.role === 'admin';

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

  private async enforce<R extends ResourceName>({
    userId,
    clientMeta: { ip, userAgent },
    permission,
    session,
    requireActive = false,
  }: {
    userId: string;
    clientMeta: ClientMeta;
    permission: { resource: R; action: ActionOf<R> } | undefined;
    session?: { sessionId: string | null };
    requireActive?: boolean;
  }): Promise<AdminCaller> {
    const deniedResource = permission?.resource ?? 'admin';
    const deniedAction = permission?.action ?? 'access';

    const { account, granted } = await this.resolveAccess(userId, permission ? [permission] : []);
    if (!account || (requireActive && !account.isActive) || !account.isAdmin) {
      this.emitUnauthorized(userId, account?.role, deniedResource, deniedAction, ip, userAgent);
      throw new ORPCError('FORBIDDEN', {
        message: 'Admin access required',
        data: { reason: AuthGuardReasonSchema.enum.admin_required },
      });
    }

    if (permission && granted.length === 0) {
      const { resource, action } = permission;
      this.emitUnauthorized(userId, account.role, resource, action, ip, userAgent);
      throw new ORPCError('FORBIDDEN', {
        message: `Missing permission: ${String(resource)}:${String(action)}`,
        data: {
          reason: AuthGuardReasonSchema.enum.permission_denied,
          resource: String(resource),
          action: String(action),
        },
      });
    }

    if (this.securityPolicy) {
      const securityContext = { userId, sessionId: session?.sessionId ?? null, ip, userAgent };
      await this.securityPolicy.assertEnrolled(securityContext);
      if (session) {
        await this.securityPolicy.assertSessionIntact(securityContext);
      }
    }

    return { userId, role: account.role, ip, userAgent };
  }

  /**
   * The account behind `userId` and which of `requirements` it holds under `holdsGrant`. Grants
   * are read only for an account whose role the static table knows, and only when there is
   * something to check.
   */
  private async resolveAccess<T extends GrantRequirement>(
    userId: string,
    requirements: readonly T[],
  ) {
    const account = await this.findAccount(userId);
    if (!account?.isAdmin || requirements.length === 0) {
      return { account, granted: [] };
    }
    const grants = await this.resolveGrants(userId);
    return {
      account,
      granted: requirements.filter(({ resource, action }) =>
        holdsGrant({ role: account.role, grants }, resource, action),
      ),
    };
  }

  private async findAccount(userId: string) {
    const result = await this.drizzle.db.execute<{ role: string; is_active: boolean }>(
      sql`SELECT role, is_active FROM "user" WHERE id = ${userId} LIMIT 1`,
    );
    const row = result.rows[0];
    return row && { role: row.role, isActive: row.is_active, isAdmin: isRoleName(row.role) };
  }

  // null only when no resolver is bound - an unassigned admin under a bound resolver gets [].
  private resolveGrants(userId: string): Promise<AdminGrant[] | null> {
    return this.permissionResolver
      ? this.permissionResolver.getGrants(userId)
      : Promise.resolve(null);
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
