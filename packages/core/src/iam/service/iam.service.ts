import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  statement,
  roles,
  readActions,
  SUPPORTED_LEVELS,
  levelToActions,
  levelRank,
  isLevelSufficient,
  type ResourceName,
  type RoleName,
  type PermissionLevel,
} from '@blurifycom/core/server';
import { eq, and, gt, inArray, sql } from 'drizzle-orm';
import type {
  SendEmailPort,
  AdminPermissionResolver,
  AdminGrant,
} from '@blurifycom/core/contracts';
import {
  adminRole,
  adminRolePermission,
  adminRoleAssignment,
  adminInvitation,
} from '../schema/index.js';
// Read-only cross-domain schema import (sanctioned): assignRole verifies the target is an admin user.
import { user } from '@blurifycom/core/pam/schema/identity';
import type { AdminInvitation, EffectivePermissions } from '../contract/index.js';

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
// Privilege escalation guard: mapped to FORBIDDEN in the router.
export const GrantEscalationError = createDomainError(
  'GrantEscalationError',
  () => 'Cannot grant or assign permissions you do not hold',
);
export const NotSuperAdminError = createDomainError(
  'NotSuperAdminError',
  () => 'Super-admin access required',
);
export const AdminUserNotFoundError = makeNotFoundError('AdminUser');
// Guards against assigning a backoffice role to a player account (privilege escalation).
export const NotAnAdminUserError = createDomainError(
  'NotAnAdminUserError',
  () => 'Roles can only be assigned to admin users',
);
export const ProtectedRoleError = makeConflictError(
  'AdminRole',
  'This role is protected and cannot be modified or deleted',
);
// Removing the final super-admin assignment would lock out admin management.
export const LastSuperAdminError = makeConflictError(
  'AdminRole',
  'Cannot remove the last super-admin',
);

type Caller = { userId: string; role: string };

type Page = { page: number; limit: number };

// The `admin` module is NOT operator-assignable: granting `admin: read_write` to a
// custom role would pass the router's adminGuard - it must come ONLY from `isSuperAdmin`.
const NON_ASSIGNABLE_MODULES: ReadonlySet<string> = new Set(['admin']);

function buildCatalog() {
  return {
    modules: (Object.keys(statement) as ResourceName[])
      .filter((resource) => !NON_ASSIGNABLE_MODULES.has(resource))
      .map((resource) => ({
        resource,
        actions: (statement[resource] as readonly string[]).slice(),
        readActions: (readActions[resource] ?? []).slice(),
      })),
    levels: SUPPORTED_LEVELS.slice(),
  };
}

function validateGrants(grants: ReadonlyArray<{ resource: string; level: string }>): void {
  for (const g of grants) {
    const known = statement[g.resource as ResourceName] as readonly string[] | undefined;
    // `admin` grants are super-admin-only (A6) and must not be assignable via the matrix.
    if (!known || NON_ASSIGNABLE_MODULES.has(g.resource)) {
      throw new InvalidGrantError();
    }
    if (!SUPPORTED_LEVELS.includes(g.level as PermissionLevel)) {
      throw new InvalidGrantError();
    }
  }
}

function staticGrantsForRole(roleName: string) {
  const role = roles[roleName as RoleName];
  if (!role) return [];
  return (Object.keys(statement) as ResourceName[]).flatMap((resource) =>
    (statement[resource] as readonly string[])
      .filter((action) => role.authorize({ [resource]: [action] }).success)
      .map((action) => ({ resource: resource as string, action })),
  );
}

function grantsToLevelMap(grants: readonly AdminGrant[]) {
  const byResource = new Map<string, Set<string>>();
  for (const g of grants) {
    if (!byResource.has(g.resource)) byResource.set(g.resource, new Set());
    byResource.get(g.resource)!.add(g.action);
  }
  const map: Record<string, PermissionLevel> = {};
  for (const [resource, actions] of byResource) {
    const all = statement[resource as ResourceName] as readonly string[] | undefined;
    if (!all) continue;
    if (all.every((a) => actions.has(a))) {
      map[resource] = 'read_write';
    } else {
      const read = readActions[resource as ResourceName] ?? [];
      map[resource] = read.length > 0 && read.every((a) => actions.has(a)) ? 'read' : 'no_access';
    }
  }
  return map;
}

function toRoleDto(row: typeof adminRole.$inferSelect) {
  return {
    id: row.id,
    key: row.key ?? null,
    name: row.name,
    isSystem: row.isSystem,
    isSuperAdmin: row.isSuperAdmin,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAssignmentDto(row: typeof adminRoleAssignment.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvitationDto(row: typeof adminInvitation.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    token: row.token,
    status: row.status as AdminInvitation['status'],
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Implements ADMIN_PERMISSION_RESOLVER; returns null when the user has no DB assignment (guard falls back to static roles for the bootstrap admin path). */
export class DbAdminPermissionResolver implements AdminPermissionResolver {
  constructor(private readonly drizzle: DrizzleService) {}

  async getGrants(userId: string) {
    const db = this.drizzle.db;

    const assignments = await db
      .select({ roleId: adminRoleAssignment.roleId })
      .from(adminRoleAssignment)
      .where(eq(adminRoleAssignment.userId, userId));

    if (assignments.length === 0) {
      return null;
    }

    const roleIds = assignments.map((a) => a.roleId);

    // Super-admin bypass: skip level rows entirely.
    const superRows = await db
      .select({ id: adminRole.id })
      .from(adminRole)
      .where(and(inArray(adminRole.id, roleIds), eq(adminRole.isSuperAdmin, true)));
    if (superRows.length > 0) {
      return allGrants();
    }

    const rows = await Promise.all(
      roleIds.map((roleId) =>
        db
          .select({
            resource: adminRolePermission.resource,
            level: adminRolePermission.level,
          })
          .from(adminRolePermission)
          .where(eq(adminRolePermission.roleId, roleId)),
      ),
    );

    const seen = new Set<string>();
    const grants: AdminGrant[] = [];
    for (const r of rows.flat()) {
      for (const action of levelToActions(r.resource, r.level as PermissionLevel)) {
        const key = `${r.resource}:${action}`;
        if (seen.has(key)) continue;
        seen.add(key);
        grants.push({ resource: r.resource, action });
      }
    }
    return grants;
  }
}

function allGrants() {
  return (Object.keys(statement) as ResourceName[]).flatMap((resource) =>
    (statement[resource] as readonly string[]).map((action) => ({
      resource: resource as string,
      action,
    })),
  );
}

export class IamService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly email: SendEmailPort,
  ) {}

  private async callerGrants(caller: Caller) {
    const resolver = new DbAdminPermissionResolver(this.drizzle);
    const dbGrants = await resolver.getGrants(caller.userId);
    return dbGrants ?? staticGrantsForRole(caller.role);
  }

  // True for a DB super-admin assignment OR (no DB row AND user.role === 'admin').
  // The second clause keeps the bootstrap admin accessible before any role is seeded.
  // `user.role` is written only by trusted provisioning (seed/IdP), so it is safe here.
  private async isSuperAdmin(caller: Caller) {
    const assignments = await this.drizzle.db
      .select({ roleId: adminRoleAssignment.roleId })
      .from(adminRoleAssignment)
      .where(eq(adminRoleAssignment.userId, caller.userId));

    if (assignments.length === 0) {
      return caller.role === 'admin';
    }

    const roleIds = assignments.map((a) => a.roleId);
    const superRows = await this.drizzle.db
      .select({ id: adminRole.id })
      .from(adminRole)
      .where(and(inArray(adminRole.id, roleIds), eq(adminRole.isSuperAdmin, true)));
    return superRows.length > 0;
  }

  private async assertSuperAdmin(caller: Caller) {
    if (!(await this.isSuperAdmin(caller))) {
      throw new NotSuperAdminError();
    }
  }

  listCatalog() {
    return buildCatalog();
  }

  private async rolePermissions(roleId: string) {
    const rows = await this.drizzle.db
      .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
      .from(adminRolePermission)
      .where(eq(adminRolePermission.roleId, roleId));
    return rows.map((r) => ({ resource: r.resource, level: r.level as PermissionLevel }));
  }

  async listRoles({ page, limit }: Page) {
    const offset = pageToOffset(page, limit);
    const [rows, countResult] = await Promise.all([
      this.drizzle.db.select().from(adminRole).limit(limit).offset(offset),
      this.drizzle.db.select({ count: sql<number>`count(*)::int` }).from(adminRole),
    ]);
    const items = await Promise.all(
      rows.map(async (row) => ({
        ...toRoleDto(row),
        permissions: await this.rolePermissions(row.id),
      })),
    );
    return { items, total: countResult[0]?.count ?? 0, page, limit };
  }

  async getRole(roleId: string) {
    const row = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, roleId)),
      new RoleNotFoundError(roleId),
    );
    return { ...toRoleDto(row), permissions: await this.rolePermissions(roleId) };
  }

  async createRole(input: { name: string; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    const [row] = await this.drizzle.db.insert(adminRole).values({ name: input.name }).returning();
    const dto = toRoleDto(row!);
    this.events.emit('iam.role.created', {
      roleId: dto.id,
      name: dto.name,
      actorId: input.caller.userId,
    });
    return dto;
  }

  async updateRole(input: { roleId: string; name?: string; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    // The super-admin role bypasses authz and must never be renamed.
    if (existing.isSuperAdmin) {
      throw new ProtectedRoleError();
    }

    const patch: Partial<typeof adminRole.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;

    const [row] = await this.drizzle.db
      .update(adminRole)
      .set(patch)
      .where(eq(adminRole.id, input.roleId))
      .returning();
    const dto = toRoleDto(row!);
    this.events.emit('iam.role.updated', {
      roleId: dto.id,
      name: input.name,
      actorId: input.caller.userId,
    });
    return dto;
  }

  async deleteRole(input: { roleId: string; caller: Caller }): Promise<{ success: true }> {
    await this.assertSuperAdmin(input.caller);
    const row = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );
    if (row.isSystem || row.isSuperAdmin) {
      throw new ProtectedRoleError();
    }

    // The three child FKs are ON DELETE CASCADE, so deleting the role removes permission,
    // assignment, and invitation rows automatically. Holder rows are read FOR UPDATE inside
    // the tx so a concurrent assign cannot slip a row past the audit.
    const affectedUserIds = await this.drizzle.db.transaction(async (txn) => {
      const holders = await txn
        .select({ userId: adminRoleAssignment.userId })
        .from(adminRoleAssignment)
        .where(eq(adminRoleAssignment.roleId, input.roleId))
        .for('update');

      await txn.delete(adminRole).where(eq(adminRole.id, input.roleId));

      return holders.map((h) => h.userId);
    });

    // One revoke per affected admin so each lost-role is individually attributable in the audit log.
    for (const userId of affectedUserIds) {
      this.events.emit('iam.role.revoked', {
        roleId: input.roleId,
        userId,
        actorId: input.caller.userId,
      });
    }
    this.events.emit('iam.role.deleted', {
      roleId: input.roleId,
      actorId: input.caller.userId,
    });
    return { success: true };
  }

  async setRolePermissions(input: {
    roleId: string;
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

    // No-escalation check retained for a future delegated-admin mode; today
    // assertSuperAdmin already proved the caller holds all levels.
    const callerMap = grantsToLevelMap(await this.callerGrants(input.caller));
    for (const g of input.grants) {
      if (g.level === 'no_access') continue;
      const have = callerMap[g.resource] ?? 'no_access';
      if (!isLevelSufficient(have, g.level)) {
        throw new GrantEscalationError();
      }
    }

    // Replace in one transaction - a crash or concurrent call must not leave the role at no_access.
    const persist = input.grants.filter((g) => g.level !== 'no_access');
    const { before, after } = await this.drizzle.db.transaction(async (txn) => {
      const beforeRows = await txn
        .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
        .from(adminRolePermission)
        .where(eq(adminRolePermission.roleId, input.roleId));

      await txn.delete(adminRolePermission).where(eq(adminRolePermission.roleId, input.roleId));

      if (persist.length > 0) {
        await txn.insert(adminRolePermission).values(
          persist.map((g) => ({
            roleId: input.roleId,
            resource: g.resource,
            level: g.level,
          })),
        );
      }

      const afterRows = await txn
        .select({ resource: adminRolePermission.resource, level: adminRolePermission.level })
        .from(adminRolePermission)
        .where(eq(adminRolePermission.roleId, input.roleId));

      const toLevels = (rows: { resource: string; level: string }[]) =>
        rows.map((r) => ({ resource: r.resource, level: r.level as PermissionLevel }));
      return { before: toLevels(beforeRows), after: toLevels(afterRows) };
    });

    this.events.emit('iam.role.permissions.changed', {
      roleId: input.roleId,
      before,
      after,
      actorId: input.caller.userId,
    });

    return this.getRole(input.roleId);
  }

  async assignRole(input: { userId: string; roleId: string; caller: Caller }) {
    await this.assertSuperAdmin(input.caller);
    findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    // The target must be an admin account - the resolver grants admin access to anyone with
    // an assignment row, so assigning to a player would silently escalate them.
    const target = findOneOrThrow(
      await this.drizzle.db.select({ role: user.role }).from(user).where(eq(user.id, input.userId)),
      new AdminUserNotFoundError(input.userId),
    );
    if (target.role !== 'admin') {
      throw new NotAnAdminUserError();
    }

    // Return the existing row rather than 500-ing on the unique (userId, roleId) index.
    const existing = await this.drizzle.db
      .select()
      .from(adminRoleAssignment)
      .where(
        and(
          eq(adminRoleAssignment.userId, input.userId),
          eq(adminRoleAssignment.roleId, input.roleId),
        ),
      );
    if (existing.length > 0) {
      return toAssignmentDto(existing[0]!);
    }

    const [row] = await this.drizzle.db
      .insert(adminRoleAssignment)
      .values({ userId: input.userId, roleId: input.roleId })
      .returning();
    const dto = toAssignmentDto(row!);
    this.events.emit('iam.role.assigned', {
      roleId: input.roleId,
      userId: input.userId,
      actorId: input.caller.userId,
    });
    return dto;
  }

  async unassignRole(input: {
    userId: string;
    roleId: string;
    caller: Caller;
  }): Promise<{ success: true }> {
    await this.assertSuperAdmin(input.caller);
    const role = findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    // Count-then-delete must be atomic (TOCTOU). Lock super-admin holder rows FOR UPDATE
    // so a concurrent unassign blocks until after the first commits.
    const deleted = await this.drizzle.db.transaction(async (txn) => {
      if (role.isSuperAdmin) {
        const superRoleRows = await txn
          .select({ id: adminRole.id })
          .from(adminRole)
          .where(eq(adminRole.isSuperAdmin, true));
        const superRoleIds = superRoleRows.map((r) => r.id);
        const holders = await txn
          .select({ userId: adminRoleAssignment.userId, roleId: adminRoleAssignment.roleId })
          .from(adminRoleAssignment)
          .where(inArray(adminRoleAssignment.roleId, superRoleIds))
          .for('update');
        const remaining = holders.filter(
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
      return removed.length > 0;
    });

    // No-op unassign returns success but emits nothing - no ghost revocation in the audit log.
    if (deleted) {
      this.events.emit('iam.role.revoked', {
        roleId: input.roleId,
        userId: input.userId,
        actorId: input.caller.userId,
      });
    }
    return { success: true };
  }

  async listAssignments(input: Page & { userId?: string }) {
    const { page, limit, userId } = input;
    const offset = pageToOffset(page, limit);
    const where = userId ? eq(adminRoleAssignment.userId, userId) : undefined;

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
    input: { userId: string } | { roleIds: string[] },
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
      if (!cur || levelRank(level) > levelRank(cur)) max.set(r.resource, level);
    }
    return {
      permissions: [...max.entries()].map(([resource, level]) => ({ resource, level })),
    };
  }

  async listInvitations({ page, limit }: Page) {
    const offset = pageToOffset(page, limit);
    const [rows, countResult] = await Promise.all([
      this.drizzle.db.select().from(adminInvitation).limit(limit).offset(offset),
      this.drizzle.db.select({ count: sql<number>`count(*)::int` }).from(adminInvitation),
    ]);
    return { items: rows.map(toInvitationDto), total: countResult[0]?.count ?? 0, page, limit };
  }

  async inviteAdmin(input: { email: string; roleId: string; caller: Caller }) {
    // Inviting to a role is a role grant by another name, so it is super-admin-only -
    // consistent with assignRole. A non-super admin must not invite to a role
    // exceeding their own (esp. super-admin).
    await this.assertSuperAdmin(input.caller);
    findOneOrThrow(
      await this.drizzle.db.select().from(adminRole).where(eq(adminRole.id, input.roleId)),
      new RoleNotFoundError(input.roleId),
    );

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [row] = await this.drizzle.db
      .insert(adminInvitation)
      .values({
        email: input.email,
        roleId: input.roleId,
        token,
        status: 'pending',
        expiresAt,
      })
      .returning();

    await this.email.send({
      to: input.email,
      subject: 'You have been invited as an administrator',
      body: `Your admin invitation token: ${token}. It expires at ${expiresAt.toISOString()}.`,
    });

    return toInvitationDto(row!);
  }

  async acceptInvitation(token: string): Promise<{ success: true; email: string }> {
    // Atomic conditional UPDATE: the DB evaluates pending + not-expired under row lock,
    // so two concurrent accepts cannot both succeed. Public path - tenant is derived
    // from the row, not the request, so no tenant predicate is needed.
    const now = new Date();
    const [row] = await this.drizzle.db
      .update(adminInvitation)
      .set({ status: 'accepted', acceptedAt: now })
      .where(
        and(
          eq(adminInvitation.token, token),
          eq(adminInvitation.status, 'pending'),
          gt(adminInvitation.expiresAt, now),
        ),
      )
      .returning();

    if (!row) {
      throw new InvitationConflictError();
    }

    // Emit only on actual transition - a replayed accept must never double-provision.
    this.events.emit('iam.invitation.accepted', {
      email: row.email,
      roleId: row.roleId,
      invitationId: row.id,
    });

    return { success: true, email: row.email };
  }
}
