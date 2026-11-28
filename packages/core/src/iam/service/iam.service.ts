import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  serializeRow,
  statement,
  readActionsOf,
  actionsOf,
  SUPPORTED_LEVELS,
  levelRank,
  isLevelSufficient,
  cached,
  invalidate,
  createLogger,
  assertRateLimit,
  type DrizzleTx,
  type ResourceName,
  type PermissionLevel,
} from '@openora/core/server';
import { eq, and, gt, inArray, sql, asc, desc } from 'drizzle-orm';
import type {
  MailDispatchPort,
  AdminPermissionResolver,
  AdminGrant,
  IdentityReader,
  CacheAdapter,
  SessionCommands,
  User,
  UserCommands,
  ClientMeta,
  SortOrder,
  PageQuery,
  PaginationOptions,
  RateLimiterAdapter,
  RateLimitKey,
} from '@openora/core/contracts';
import { RATE_LIMIT_KEYS, makeRateLimitKey } from '@openora/core/contracts';
import {
  adminRole,
  adminRolePermission,
  adminRoleAssignment,
  adminInvitation,
  type AdminRole,
} from '../schema/index.js';
import { user } from '@openora/core/pam/schema/identity';
import type {
  EffectivePermissions,
  IamRoleSortBy,
  IamInvitationSortBy,
} from '../contract/index.js';
import { loadAdminGrants, usersWithoutMcpAccess } from '../shared/admin-grants.js';
import { generateInvitationToken, hashInvitationToken } from '../shared/invitation-token.js';
import {
  activeSuperAdminHoldings,
  lockSuperAdminManagement,
} from '../shared/super-admin-retention.js';
import type { McpTokenService } from './mcp-token.service.js';

const logger = createLogger('iam-service');

export const RoleNotFoundError = makeNotFoundError('AdminRole');
export const InvitationNotFoundError = makeNotFoundError('AdminInvitation');
export const InvitationConflictError = makeConflictError(
  'AdminInvitation',
  'Invitation already exists or token invalid',
);
export const InvalidGrantError = createDomainError(
  'InvalidGrantError',
  () => 'Unknown module or level',
);
export const GrantEscalationError = createDomainError(
  'GrantEscalationError',
  () => 'Cannot grant or assign permissions you do not hold',
);
export const NotSuperAdminError = createDomainError(
  'NotSuperAdminError',
  () => 'Super-admin access required',
);
export const AdminUserNotFoundError = makeNotFoundError('AdminUser');
export const NotAnAdminUserError = createDomainError(
  'NotAnAdminUserError',
  () => 'Roles can only be assigned to admin users',
);
export const ProtectedRoleError = makeConflictError(
  'AdminRole',
  'This role is protected and cannot be modified or deleted',
);
export const LastSuperAdminError = makeConflictError(
  'AdminRole',
  'Cannot remove the last active super-admin',
);

type Caller = { userId: User['id']; role: string } & ClientMeta;

const NON_ASSIGNABLE_MODULES: ReadonlySet<string> = new Set(['admin']);

function buildCatalog() {
  return {
    modules: (Object.keys(statement) as ResourceName[])
      .filter((resource) => !NON_ASSIGNABLE_MODULES.has(resource))
      .map((resource) => ({
        resource,
        actions: (statement[resource] as readonly string[]).slice(),
        readActions: readActionsOf(statement[resource] as readonly string[]),
      })),
    levels: SUPPORTED_LEVELS.slice(),
  };
}

export function validateGrants(grants: ReadonlyArray<{ resource: string; level: string }>): void {
  for (const g of grants) {
    const known = actionsOf(g.resource);
    if (!known || NON_ASSIGNABLE_MODULES.has(g.resource)) {
      throw new InvalidGrantError();
    }
    if (!SUPPORTED_LEVELS.includes(g.level as PermissionLevel)) {
      throw new InvalidGrantError();
    }
  }
}

export function grantsToLevelMap(grants: readonly AdminGrant[]) {
  const byResource = new Map<string, Set<string>>();
  for (const g of grants) {
    let actions = byResource.get(g.resource);
    if (!actions) {
      actions = new Set();
      byResource.set(g.resource, actions);
    }
    actions.add(g.action);
  }
  const map: Record<string, PermissionLevel> = {};
  for (const [resource, actions] of byResource) {
    const all = actionsOf(resource);
    if (!all) {
      continue;
    }
    if (all.every((a) => actions.has(a))) {
      map[resource] = 'read_write';
    } else {
      const read = readActionsOf(all);
      map[resource] = read.length > 0 && read.every((a) => actions.has(a)) ? 'read' : 'no_access';
    }
  }
  return map;
}

function toRoleDto(row: typeof adminRole.$inferSelect) {
  return serializeRow(row, { dateFields: ['createdAt'] });
}

function toAssignmentDto(row: typeof adminRoleAssignment.$inferSelect) {
  return serializeRow(row, { dateFields: ['createdAt'] });
}

function toInvitationDto({ tokenHash: _tokenHash, ...row }: typeof adminInvitation.$inferSelect) {
  return serializeRow(row, { dateFields: ['expiresAt', 'acceptedAt', 'createdAt'] });
}

const ACCEPT_INVITATION_RATE_LIMIT = {
  limit: 5,
  windowMs: 60 * 60 * 1000,
  onUnavailable: 'deny',
} as const;

const GRANTS_CACHE_TTL_MS = 10_000;
const grantsCacheKey = (userId: User['id']) => `admin-grants:${userId}`;
const superAdminCacheKey = (userId: User['id']) => `admin-super:${userId}`;

export class DbAdminPermissionResolver implements AdminPermissionResolver {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly cache?: CacheAdapter,
  ) {}

  getGrants(userId: User['id']) {
    return cached(this.cache, grantsCacheKey(userId), GRANTS_CACHE_TTL_MS, () =>
      this.loadGrants(userId),
    );
  }

  isSuperAdmin(userId: User['id']) {
    return cached(this.cache, superAdminCacheKey(userId), GRANTS_CACHE_TTL_MS, () =>
      this.loadSuperAdmin(userId),
    );
  }

  private async loadSuperAdmin(userId: User['id']): Promise<boolean> {
    const rows = await this.drizzle.db
      .select({ isSuperAdmin: adminRole.isSuperAdmin })
      .from(adminRoleAssignment)
      .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
      .where(eq(adminRoleAssignment.userId, userId));

    return rows.some((r) => r.isSuperAdmin);
  }

  private async loadGrants(userId: User['id']): Promise<AdminGrant[]> {
    return (await loadAdminGrants(this.drizzle.db, [userId])).get(userId) ?? [];
  }

  async invalidateUser(userId: User['id']) {
    await invalidate(this.cache, [grantsCacheKey(userId), superAdminCacheKey(userId)]);
  }

  async invalidateRole(roleId: AdminRole['id']) {
    const holders = await this.drizzle.db
      .select({ userId: adminRoleAssignment.userId })
      .from(adminRoleAssignment)
      .where(eq(adminRoleAssignment.roleId, roleId));
    if (holders.length > 0) {
      await invalidate(
        this.cache,
        holders.flatMap((h) => [grantsCacheKey(h.userId), superAdminCacheKey(h.userId)]),
      );
    }
  }
}

export type IamServiceDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  mailDispatch: MailDispatchPort;
  identityReader: IdentityReader;
  mcpTokens: McpTokenService;
  sessionCommands?: SessionCommands | undefined;
  userCommands: UserCommands;
  rateLimiter?: RateLimiterAdapter<RateLimitKey> | undefined;
};

export class IamService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly mailDispatch: MailDispatchPort;
  private readonly identityReader: IdentityReader;
  private readonly mcpTokens: McpTokenService;
  private readonly sessionCommands: SessionCommands | undefined;
  private readonly userCommands: UserCommands;
  private readonly rateLimiter: RateLimiterAdapter<RateLimitKey> | undefined;

  constructor({
    drizzle,
    events,
    mailDispatch,
    identityReader,
    mcpTokens,
    sessionCommands,
    userCommands,
    rateLimiter,
  }: IamServiceDeps) {
    this.drizzle = drizzle;
    this.events = events;
    this.mailDispatch = mailDispatch;
    this.identityReader = identityReader;
    this.mcpTokens = mcpTokens;
    this.sessionCommands = sessionCommands;
    this.userCommands = userCommands;
    this.rateLimiter = rateLimiter;
  }

  private changeGrants<T>(
    caller: Caller,
    change: (tx: DrizzleTx) => Promise<{ result: T; affectedUserIds: readonly User['id'][] }>,
    { superAdminManagement = false }: { superAdminManagement?: boolean } = {},
  ) {
    return this.drizzle.db.transaction(async (tx) => {
      if (superAdminManagement) {
        await lockSuperAdminManagement(tx);
      }
      await this.mcpTokens.lockForRevocation(tx);
      const { result, affectedUserIds } = await change(tx);
      if (affectedUserIds.length > 0) {
        await this.mcpTokens.revokeAllForUsers(
          {
            userIds: await usersWithoutMcpAccess(tx, affectedUserIds),
            reason: 'admin_role_removed',
            actorId: caller.userId,
            ip: caller.ip,
            userAgent: caller.userAgent,
          },
          tx,
        );
      }
      return result;
    });
  }

  private callerGrants(caller: Caller) {
    return new DbAdminPermissionResolver(this.drizzle).getGrants(caller.userId);
  }

  private async assertSuperAdmin(caller: Caller) {
    if (!(await new DbAdminPermissionResolver(this.drizzle).isSuperAdmin(caller.userId))) {
      this.emitDenied(caller, 'admin', 'update');
      throw new NotSuperAdminError();
    }
  }

  private emitDenied(caller: Caller, resource: string, action: string) {
    void (async () => {
      const playerId =
        caller.role === 'player'
          ? await this.identityReader.getPlayerIdByUserIdSafe(caller.userId)
          : null;
      try {
        this.events.emit('identity.user.unauthorized_access', {
          userId: caller.userId,
          playerId,
          resource,
          action,
          ip: caller.ip,
          userAgent: caller.userAgent,
          role: caller.role,
        });
      } catch (err) {
        logger.error({ err, userId: caller.userId, resource, action }, 'denial audit event failed');
      }
    })();
  }

  listCatalog() {
    return buildCatalog();
  }

  private async rolePermissions(roleId: AdminRole['id']) {
    const rows = await this.drizzle.db
      .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
      .from(adminRolePermission)
      .where(eq(adminRolePermission.roleId, roleId));
    return rows.map((r) => ({ resource: r.resource, level: r.level as PermissionLevel }));
  }

  private async rolePermissionsByRole(roleIds: AdminRole['id'][]) {
    const byRole = new Map<AdminRole['id'], { resource: string; level: PermissionLevel }[]>();
    if (roleIds.length === 0) {
      return byRole;
    }
    const rows = await this.drizzle.db
      .select({
        roleId: adminRolePermission.roleId,
        resource: adminRolePermission.resource,
        level: adminRolePermission.level,
      })
      .from(adminRolePermission)
      .where(inArray(adminRolePermission.roleId, roleIds));
    for (const r of rows) {
      const list = byRole.get(r.roleId) ?? [];
      list.push({ resource: r.resource, level: r.level });
      byRole.set(r.roleId, list);
    }
    return byRole;
  }

  async listRoles({ page, limit, sortBy, sortOrder }: PaginationOptions<object, IamRoleSortBy>) {
    const offset = pageToOffset(page, limit);
    const dir = (sortOrder ?? 'asc') === 'asc' ? asc : desc;
    const ROLE_SORT_COLS = {
      name: adminRole.name,
      createdAt: adminRole.createdAt,
      key: adminRole.key,
    } as const;
    const col = ROLE_SORT_COLS[sortBy ?? 'name'];
    const [rows, countResult] = await Promise.all([
      this.drizzle.db
        .select()
        .from(adminRole)
        .orderBy(dir(col), desc(adminRole.id))
        .limit(limit)
        .offset(offset),
      this.drizzle.db.select({ count: sql<number>`count(*)::int` }).from(adminRole),
    ]);
    const permissionsByRole = await this.rolePermissionsByRole(rows.map((r) => r.id));
    const items = rows.map((row) => ({
      ...toRoleDto(row),
      permissions: permissionsByRole.get(row.id) ?? [],
    }));
    return { items, total: countResult[0]?.count ?? 0, page, limit };
  }

  async getRole(roleId: AdminRole['id']) {
    const row = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, roleId)),
      new RoleNotFoundError(roleId),
    );
    return { ...toRoleDto(row), permissions: await this.rolePermissions(roleId) };
  }

  async createRole(input: { name: string; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    const row = findOneOrThrow(
      await this.drizzle.db.insert(adminRole).values({ name: input.name }).returning(),
      new RoleNotFoundError(input.name),
    );
    const dto = toRoleDto(row);
    this.events.emit('iam.role.created', {
      roleId: dto.id,
      name: dto.name,
      actorId: input.caller.userId,
      ip: input.caller.ip ?? null,
      userAgent: input.caller.userAgent ?? null,
    });
    return dto;
  }

  async updateRole(input: { roleId: AdminRole['id']; name?: string; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    if (existing.isSuperAdmin) {
      throw new ProtectedRoleError();
    }

    const patch: Partial<typeof adminRole.$inferInsert> = {};
    if (input.name !== undefined) {
      patch.name = input.name;
    }

    const row = findOneOrThrow(
      await this.drizzle.db
        .update(adminRole)
        .set(patch)
        .where(eq(adminRole.id, input.roleId))
        .returning(),
      new RoleNotFoundError(input.roleId),
    );
    const dto = toRoleDto(row);
    this.events.emit('iam.role.updated', {
      roleId: dto.id,
      name: input.name,
      actorId: input.caller.userId,
      ip: input.caller.ip ?? null,
      userAgent: input.caller.userAgent ?? null,
    });
    return dto;
  }

  async deleteRole(input: { roleId: AdminRole['id']; caller: Caller }): Promise<{ success: true }> {
    await this.assertSuperAdmin(input.caller);
    const row = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );
    if (row.isSystem || row.isSuperAdmin) {
      throw new ProtectedRoleError();
    }

    const affectedUserIds = await this.changeGrants(input.caller, async (txn) => {
      const holders = await txn
        .select({ userId: adminRoleAssignment.userId })
        .from(adminRoleAssignment)
        .where(eq(adminRoleAssignment.roleId, input.roleId))
        .for('update');

      await txn.delete(adminRole).where(eq(adminRole.id, input.roleId));

      const holderIds = holders.map((h) => h.userId);
      return { result: holderIds, affectedUserIds: holderIds };
    });

    for (const userId of affectedUserIds) {
      this.events.emit('iam.role.revoked', {
        roleId: input.roleId,
        userId,
        actorId: input.caller.userId,
        ip: input.caller.ip ?? null,
        userAgent: input.caller.userAgent ?? null,
      });
    }
    this.events.emit('iam.role.deleted', {
      roleId: input.roleId,
      actorId: input.caller.userId,
      ip: input.caller.ip ?? null,
      userAgent: input.caller.userAgent ?? null,
    });
    return { success: true };
  }

  async setRolePermissions(input: {
    roleId: AdminRole['id'];
    grants: ReadonlyArray<{ resource: string; level: PermissionLevel }>;
    caller: Caller;
  }) {
    await this.assertSuperAdmin(input.caller);
    const role = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    if (role.isSuperAdmin) {
      throw new ProtectedRoleError();
    }

    validateGrants(input.grants);

    const callerMap = grantsToLevelMap(await this.callerGrants(input.caller));
    for (const g of input.grants) {
      if (g.level === 'no_access') {
        continue;
      }
      const have = callerMap[g.resource] ?? 'no_access';
      if (!isLevelSufficient(have, g.level)) {
        this.emitDenied(input.caller, g.resource, 'update');
        throw new GrantEscalationError();
      }
    }

    const persist = input.grants.filter((g) => g.level !== 'no_access');
    const { before, after } = await this.changeGrants(input.caller, async (txn) => {
      const beforeRows = await txn
        .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
        .from(adminRolePermission)
        .where(eq(adminRolePermission.roleId, input.roleId));

      await txn.delete(adminRolePermission).where(eq(adminRolePermission.roleId, input.roleId));

      if (persist.length > 0) {
        await txn
          .insert(adminRolePermission)
          .values(persist.map((g) => ({ ...g, roleId: input.roleId })));
      }

      const afterRows = await txn
        .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
        .from(adminRolePermission)
        .where(eq(adminRolePermission.roleId, input.roleId));

      const holders = await txn
        .select({ userId: adminRoleAssignment.userId })
        .from(adminRoleAssignment)
        .where(eq(adminRoleAssignment.roleId, input.roleId));

      const toLevels = (rows: { resource: string; level: string }[]) =>
        rows.map((r) => ({ resource: r.resource, level: r.level as PermissionLevel }));
      return {
        result: { before: toLevels(beforeRows), after: toLevels(afterRows) },
        affectedUserIds: holders.map((h) => h.userId),
      };
    });

    this.events.emit('iam.role.permissions.changed', {
      roleId: input.roleId,
      before,
      after,
      actorId: input.caller.userId,
      ip: input.caller.ip ?? null,
      userAgent: input.caller.userAgent ?? null,
    });

    return this.getRole(input.roleId);
  }

  async assignRole(input: { userId: User['id']; roleId: AdminRole['id']; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    const target = findOneOrThrow(
      await this.drizzle.db.select({ role: user.role }).from(user).where(eq(user.id, input.userId)),
      new AdminUserNotFoundError(input.userId),
    );
    if (target.role !== 'admin') {
      throw new NotAnAdminUserError();
    }

    const [existing] = await this.drizzle.db
      .select()
      .from(adminRoleAssignment)
      .where(
        and(
          eq(adminRoleAssignment.userId, input.userId),
          eq(adminRoleAssignment.roleId, input.roleId),
        ),
      );
    if (existing) {
      return toAssignmentDto(existing);
    }

    const row = await this.changeGrants(input.caller, async (txn) => ({
      result: findOneOrThrow(
        await txn
          .insert(adminRoleAssignment)
          .values({ userId: input.userId, roleId: input.roleId })
          .returning(),
        new RoleNotFoundError(input.roleId),
      ),
      affectedUserIds: [input.userId],
    }));
    const dto = toAssignmentDto(row);
    this.events.emit('iam.role.assigned', {
      roleId: input.roleId,
      userId: input.userId,
      actorId: input.caller.userId,
      ip: input.caller.ip ?? null,
      userAgent: input.caller.userAgent ?? null,
    });
    return dto;
  }

  async unassignRole(input: {
    userId: User['id'];
    roleId: AdminRole['id'];
    caller: Caller;
  }): Promise<{ success: true }> {
    await this.assertSuperAdmin(input.caller);
    const role = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    const deleted = await this.changeGrants(
      input.caller,
      async (txn) => {
        if (role.isSuperAdmin) {
          const remaining = (await activeSuperAdminHoldings(txn)).filter(
            (h) => !(h.userId === input.userId && h.roleId === input.roleId),
          );
          if (remaining.length === 0) {
            throw new LastSuperAdminError();
          }
        }

        const removed = await txn
          .delete(adminRoleAssignment)
          .where(
            and(
              eq(adminRoleAssignment.userId, input.userId),
              eq(adminRoleAssignment.roleId, input.roleId),
            ),
          )
          .returning({ id: adminRoleAssignment.id });
        const wasAssigned = removed.length > 0;
        return { result: wasAssigned, affectedUserIds: wasAssigned ? [input.userId] : [] };
      },
      { superAdminManagement: role.isSuperAdmin },
    );

    if (deleted) {
      this.events.emit('iam.role.revoked', {
        roleId: input.roleId,
        userId: input.userId,
        actorId: input.caller.userId,
        ip: input.caller.ip ?? null,
        userAgent: input.caller.userAgent ?? null,
      });
    }
    return { success: true };
  }

  async listAssignments(input: PageQuery & { userId?: User['id']; sortOrder?: SortOrder }) {
    const { page, limit, userId, sortOrder } = input;
    const offset = pageToOffset(page, limit);
    const where = userId ? eq(adminRoleAssignment.userId, userId) : undefined;
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;

    const [rows, countResult] = await Promise.all([
      this.drizzle.db
        .select({
          id: adminRoleAssignment.id,
          userId: adminRoleAssignment.userId,
          roleId: adminRoleAssignment.roleId,
          createdAt: adminRoleAssignment.createdAt,
          roleName: adminRole.name,
          roleKey: adminRole.key,
        })
        .from(adminRoleAssignment)
        .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
        .where(where)
        .orderBy(dir(adminRoleAssignment.createdAt), desc(adminRoleAssignment.id))
        .limit(limit)
        .offset(offset),
      this.drizzle.db
        .select({ count: sql<number>`count(*)::int` })
        .from(adminRoleAssignment)
        .where(where),
    ]);

    const items = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      roleId: r.roleId,
      createdAt: r.createdAt.toISOString(),
      roleName: r.roleName,
      roleKey: r.roleKey ?? null,
    }));
    return { items, total: countResult[0]?.count ?? 0, page, limit };
  }

  async previewEffectivePermissions(
    input: { userId: User['id'] } | { roleIds: string[] },
  ): Promise<EffectivePermissions> {
    let roleIds: string[];
    if ('userId' in input) {
      const assignments = await this.drizzle.db
        .select({ roleId: adminRoleAssignment.roleId })
        .from(adminRoleAssignment)
        .where(eq(adminRoleAssignment.userId, input.userId));
      roleIds = assignments.map((a) => a.roleId);
    } else {
      roleIds = input.roleIds;
    }

    if (roleIds.length === 0) {
      return { permissions: [] };
    }

    const superRows = await this.drizzle.db
      .select({ id: adminRole.id })
      .from(adminRole)
      .where(and(inArray(adminRole.id, roleIds), eq(adminRole.isSuperAdmin, true)));
    if (superRows.length > 0) {
      return {
        permissions: (Object.keys(statement) as ResourceName[]).map((resource) => ({
          resource,
          level: 'read_write',
        })),
      };
    }

    const rows = await this.drizzle.db
      .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
      .from(adminRolePermission)
      .where(inArray(adminRolePermission.roleId, roleIds));

    const max = new Map<string, PermissionLevel>();
    for (const r of rows) {
      const level = r.level as PermissionLevel;
      const cur = max.get(r.resource);
      if (!cur || levelRank(level) > levelRank(cur)) {
        max.set(r.resource, level);
      }
    }
    return {
      permissions: [...max.entries()].map(([resource, level]) => ({ resource, level })),
    };
  }

  async listInvitations({
    page,
    limit,
    sortBy,
    sortOrder,
  }: PaginationOptions<object, IamInvitationSortBy>) {
    const offset = pageToOffset(page, limit);
    const dir = (sortOrder ?? 'desc') === 'asc' ? asc : desc;
    const INV_SORT_COLS = {
      createdAt: adminInvitation.createdAt,
      expiresAt: adminInvitation.expiresAt,
      email: adminInvitation.email,
      status: adminInvitation.status,
      acceptedAt: adminInvitation.acceptedAt,
    } as const;
    const col = INV_SORT_COLS[sortBy ?? 'createdAt'];
    const [rows, countResult] = await Promise.all([
      this.drizzle.db
        .select()
        .from(adminInvitation)
        .orderBy(dir(col), desc(adminInvitation.id))
        .limit(limit)
        .offset(offset),
      this.drizzle.db.select({ count: sql<number>`count(*)::int` }).from(adminInvitation),
    ]);
    return { items: rows.map(toInvitationDto), total: countResult[0]?.count ?? 0, page, limit };
  }

  async inviteAdmin(input: { email: string; roleId: AdminRole['id']; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(adminInvitation)
        .values({
          email: input.email,
          roleId: input.roleId,
          tokenHash: hashInvitationToken(token),
          status: 'pending',
          expiresAt,
        })
        .returning(),
      new InvitationNotFoundError(input.email),
    );

    await this.mailDispatch.toAddress({
      email: input.email,
      locale: 'en',
      template: {
        key: 'adminInvitation',
        data: { token, expiresAt: expiresAt.toISOString() },
      },
      idempotencyKey: `admin-invitation:${row.id}`,
    });

    this.events.emit('iam.invitation.created', {
      email: row.email,
      roleId: row.roleId,
      invitationId: row.id,
      actorId: input.caller.userId,
      ip: input.caller.ip ?? null,
      userAgent: input.caller.userAgent ?? null,
    });

    return toInvitationDto(row);
  }

  async acceptInvitation(
    input: { token: string; name: string; password: string },
    meta?: ClientMeta,
  ): Promise<{ success: true; email: string }> {
    const rateLimitKey = makeRateLimitKey(
      RATE_LIMIT_KEYS.ADMIN_INVITATION_ACCEPT_IP,
      meta?.ip ?? 'unknown',
    );
    await assertRateLimit(this.rateLimiter, rateLimitKey, ACCEPT_INVITATION_RATE_LIMIT);

    const now = new Date();
    const { row, userId } = await this.drizzle.db.transaction(async (tx) => {
      const row = findOneOrThrow(
        await tx
          .update(adminInvitation)
          .set({ status: 'accepted', acceptedAt: now })
          .where(
            and(
              eq(adminInvitation.tokenHash, hashInvitationToken(input.token)),
              eq(adminInvitation.status, 'pending'),
              gt(adminInvitation.expiresAt, now),
            ),
          )
          .returning(),
        new InvitationConflictError(),
      );
      const { id: userId } = await this.userCommands.createAdmin(
        { email: row.email, name: input.name, password: input.password },
        tx,
      );
      await tx.insert(adminRoleAssignment).values({ userId, roleId: row.roleId });
      return { row, userId };
    });
    await this.rateLimiter?.reset(rateLimitKey);

    this.events.emit('iam.invitation.accepted', {
      email: row.email,
      roleId: row.roleId,
      invitationId: row.id,
      userId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return { success: true, email: row.email };
  }

  async forceLogout(input: { userId: User['id']; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    if (!this.sessionCommands) {
      throw new Error('SessionCommands adapter not provided');
    }
    await this.sessionCommands.revokeAll(input.userId, input.caller.userId);
    return { success: true as const };
  }

  async reportAccessDenied(input: {
    resource: string;
    level: PermissionLevel;
    caller: Caller;
  }): Promise<{ recorded: boolean }> {
    const grantMap = grantsToLevelMap(await this.callerGrants(input.caller));
    const actualLevel = grantMap[input.resource] ?? 'no_access';
    if (isLevelSufficient(actualLevel, input.level)) {
      return { recorded: false };
    }
    if (this.rateLimiter) {
      const key = makeRateLimitKey(
        RATE_LIMIT_KEYS.REPORT_ACCESS_DENIED,
        `${input.caller.userId}:${input.resource}`,
      );
      const { allowed } = await this.rateLimiter.consume(key, { limit: 1, windowMs: 60_000 });
      if (!allowed) {
        return { recorded: false };
      }
    }
    this.emitDenied(input.caller, input.resource, 'access');
    return { recorded: true };
  }
}
