import { ORPCError } from '@orpc/server';
import {
  createToken,
  AuthGuardReasonSchema,
  type Token,
  type AdminPermissionResolver,
  type AdminGrant,
  type AdminSecurityPolicy,
  type AccountReader,
  type IdentityReader,
  type ClientMeta,
} from '@openora/core/contracts';
import { DrizzleService, mapConcurrent } from '../db/index.js';
import { sql } from 'drizzle-orm';
import type { SessionResolver } from './session-resolver.js';
import { holdsGrant, isRoleName, type ResourceName, type ActionOf } from './permissions.js';
import type { OssContext, EventBus } from '../kernel/index.js';
import { createLogger } from '../kernel/logger.js';
import {
  extractClientMeta,
  throwIfSessionUnavailable,
  type AuthContext,
} from '../kernel/router-utils.js';
import { getCurrentClientMeta, noteGrantedPermission } from '../kernel/request-context.js';

export const ADMIN_GUARD: Token<AdminGuard> = createToken('ADMIN_GUARD');

const logger = createLogger('admin-guard');

export type AdminCaller = { userId: string; role: string } & ClientMeta;

type GrantRequirement = { resource: string; action: string };

const GRANT_RESOLVE_CONCURRENCY = 10;

const canonicalUserId = (userId: string) => userId.toLowerCase();

const toHeaders = (raw: OssContext['request']['headers']) => {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) {
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
  }
  return headers;
};

const sessionOf = (auth: AuthContext | undefined) =>
  auth && { userId: auth.userId, sessionId: auth.sessionId };

const heldRequirements = <T extends GrantRequirement>(
  role: string,
  grants: AdminGrant[] | null,
  requirements: readonly T[],
) => requirements.filter(({ resource, action }) => holdsGrant({ role, grants }, resource, action));

export class AdminGuard {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly sessions: Pick<SessionResolver, 'resolveSession'> | undefined,
    private readonly permissionResolver?: AdminPermissionResolver,
    private readonly events?: EventBus,
    private readonly identityReader?: Pick<IdentityReader, 'getPlayerIdByUserIdSafe'>,
    private readonly securityPolicy?: AdminSecurityPolicy,
    private readonly accounts?: AccountReader,
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

    const resolvedSession = this.sessions
      ? await this.sessions.resolveSession(toHeaders(request.headers))
      : sessionOf((context as { auth?: AuthContext }).auth);
    const userId = resolvedSession?.userId;
    if (!userId) {
      throwIfSessionUnavailable(context);
      const idleEnded = (context as { sessionEndedReason?: string }).sessionEndedReason;
      throw new ORPCError('UNAUTHORIZED', {
        message: idleEnded ? 'Signed out after inactivity' : 'Authentication required',
        data: {
          reason: idleEnded
            ? AuthGuardReasonSchema.enum.session_idle_timeout
            : AuthGuardReasonSchema.enum.authentication_required,
        },
      });
    }

    const caller = await this.enforce({
      userId,
      clientMeta: { ip, userAgent },
      permission: resource !== undefined && action !== undefined ? { resource, action } : undefined,
      session: { sessionId: resolvedSession?.sessionId ?? null },
    });
    if (resource !== undefined && action !== undefined) {
      noteGrantedPermission({ userId, resource, action, ip, userAgent });
    }
    return caller;
  }

  async assertUser<R extends ResourceName>(
    userId: string,
    resource: R,
    action: ActionOf<R>,
  ): Promise<AdminCaller> {
    return this.enforce({
      userId,
      clientMeta: { ip: null, userAgent: null },
      permission: { resource, action },
    });
  }

  async filterGranted<T extends GrantRequirement>(
    userId: string,
    requirements: readonly T[],
  ): Promise<T[]> {
    const granted =
      (await this.filterGrantedUsers([userId], requirements)).get(canonicalUserId(userId)) ?? [];
    for (const { resource, action } of granted) {
      noteGrantedPermission({ userId, resource, action, ...getCurrentClientMeta() });
    }
    return granted;
  }

  async filterGrantedUsers<T extends GrantRequirement>(
    userIds: readonly string[],
    requirements: readonly T[],
  ): Promise<Map<string, T[]>> {
    if (userIds.length === 0 || requirements.length === 0) {
      return new Map();
    }
    const active = await this.activeRoles(userIds);
    const admins = active.filter(({ role }) => isRoleName(role));
    const entries = await mapConcurrent(
      admins,
      GRANT_RESOLVE_CONCURRENCY,
      async ({ id, role }) =>
        [id, heldRequirements(role, await this.resolveGrants(id), requirements)] as const,
    );
    return new Map(entries.filter(([, held]) => held.length > 0));
  }

  async assertSuperAdmin(
    context: unknown,
    subject: { resource: string; action: string } = { resource: 'admin', action: 'super-admin' },
  ): Promise<AdminCaller> {
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
    noteGrantedPermission({
      userId: caller.userId,
      ...subject,
      ip: caller.ip,
      userAgent: caller.userAgent,
    });
    return caller;
  }

  private async enforce<R extends ResourceName>({
    userId: rawUserId,
    clientMeta: { ip, userAgent },
    permission,
    session,
  }: {
    userId: string;
    clientMeta: ClientMeta;
    permission: { resource: R; action: ActionOf<R> } | undefined;
    session?: { sessionId: string | null };
  }): Promise<AdminCaller> {
    const userId = canonicalUserId(rawUserId);
    const deniedResource = permission?.resource ?? 'admin';
    const deniedAction = permission?.action ?? 'access';

    const { account, granted } = await this.resolveAccess(userId, permission ? [permission] : []);
    if (!account || !account.isActive || !account.isAdmin) {
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

  private async resolveAccess<T extends GrantRequirement>(
    userId: string,
    requirements: readonly T[],
  ) {
    const account = await this.findAccount(userId);
    if (!account?.isAdmin || requirements.length === 0) {
      return { account, granted: [] };
    }
    const grants = await this.resolveGrants(userId);
    return { account, granted: heldRequirements(account.role, grants, requirements) };
  }

  private async activeRoles(userIds: readonly string[]): Promise<{ id: string; role: string }[]> {
    if (this.accounts) {
      const accounts = await this.accounts.getAccounts(userIds, { fresh: true });
      return [...accounts.values()]
        .filter((account) => account.isActive)
        .map((account) => ({ id: canonicalUserId(account.userId), role: account.role }));
    }
    const result = await this.drizzle.db.execute<{ id: string; role: string }>(
      sql`SELECT id, role FROM "user" WHERE is_active AND id = ANY(${sql.param([...userIds])}::uuid[])`,
    );
    return result.rows;
  }

  private async findAccount(userId: string) {
    const row = this.accounts
      ? (await this.accounts.getAccounts([userId], { fresh: true })).get(userId)
      : await this.drizzle.db
          .execute<{ role: string; isActive: boolean }>(
            sql`SELECT role, is_active AS "isActive" FROM "user" WHERE id = ${userId} LIMIT 1`,
          )
          .then((result) => result.rows[0]);
    return row && { role: row.role, isActive: row.isActive, isAdmin: isRoleName(row.role) };
  }

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
