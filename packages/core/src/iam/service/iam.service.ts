import {
  type EventBus,
  makeNotFoundError,
  makeConflictError,
  createDomainError,
  getCurrentTenantId,
} from '@oss/core/server';
import { DrizzleService, findOneOrThrow } from '@oss/core/server';
import { eq, and, gt } from 'drizzle-orm';
import {
  statement,
  roles,
  type ResourceName,
  type ActionOf,
  type RoleName,
} from '@oss/core/server';
import type { SendEmailPort } from '@oss/core/contracts';
import type { AdminPermissionResolver, AdminGrant } from '@oss/core/contracts';
import {
  adminRole,
  adminRolePermission,
  adminRoleAssignment,
  adminInvitation,
} from '../schema/index.js';
import type {
  AdminRole,
  AdminRoleWithGrants,
  AdminRoleAssignment,
  AdminInvitation,
  CatalogEntry,
} from '../schemas/index.js';

export const RoleNotFoundError = makeNotFoundError('AdminRole');
export const InvitationNotFoundError = makeNotFoundError('AdminInvitation');
export const InvitationConflictError = makeConflictError(
  'AdminInvitation',
  'Invitation already exists or token invalid',
);
// Thrown when a grant references a (resource, action) pair not in the catalog.
// Distinct from a conflict - it is a malformed request, mapped to BAD_REQUEST.
export const InvalidGrantError = createDomainError(
  'InvalidGrantError',
  () => 'Unknown resource or action',
);
// Thrown when a caller tries to grant/assign a permission they do not themselves
// hold (privilege escalation). Mapped to FORBIDDEN in the router.
export const GrantEscalationError = createDomainError(
  'GrantEscalationError',
  () => 'Cannot grant or assign permissions you do not hold',
);

// Build the resource->actions catalog from the imported statement.
// Derived at runtime so it stays in sync with permissions.ts automatically.
function buildCatalog(): CatalogEntry[] {
  return (Object.keys(statement) as ResourceName[]).map((resource) => ({
    resource,
    actions: (statement[resource] as ReadonlyArray<ActionOf<typeof resource>>).slice(),
  }));
}

// Validate that every (resource, action) pair in `grants` exists in `statement`.
function validateGrants(grants: ReadonlyArray<{ resource: string; action: string }>): void {
  for (const g of grants) {
    const validActions = statement[g.resource as ResourceName] as ReadonlyArray<string> | undefined;
    if (!validActions || !validActions.includes(g.action)) {
      throw new InvalidGrantError();
    }
  }
}

// Static grant set for a role name from `permissions.ts` (the bootstrap source
// of truth before any DB assignment exists).
function staticGrantsForRole(roleName: string): AdminGrant[] {
  const role = roles[roleName as RoleName];
  if (!role) return [];
  return (Object.keys(statement) as ResourceName[]).flatMap((resource) =>
    (statement[resource] as ReadonlyArray<string>)
      .filter((action) => role.authorize({ [resource]: [action] }).success)
      .map((action) => ({ resource: resource as string, action })),
  );
}

// True iff every (resource, action) in `requested` is present in `held`.
function isSubset(
  requested: ReadonlyArray<{ resource: string; action: string }>,
  held: ReadonlyArray<AdminGrant>,
): boolean {
  return requested.every((r) =>
    held.some((h) => h.resource === r.resource && h.action === r.action),
  );
}

function toRoleDto(row: typeof adminRole.$inferSelect): AdminRole {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPermissionDto(row: typeof adminRolePermission.$inferSelect) {
  return {
    id: row.id,
    roleId: row.roleId,
    resource: row.resource,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAssignmentDto(row: typeof adminRoleAssignment.$inferSelect): AdminRoleAssignment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    roleId: row.roleId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvitationDto(row: typeof adminInvitation.$inferSelect): AdminInvitation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    roleId: row.roleId,
    token: row.token,
    status: row.status as AdminInvitation['status'],
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// DbAdminPermissionResolver - implements the ADMIN_PERMISSION_RESOLVER port.
// Reads role assignments and grants from this module's own tables.
// Returns null when the user has no DB-backed assignment (guard falls back to static roles).
export class DbAdminPermissionResolver implements AdminPermissionResolver {
  constructor(private readonly drizzle: DrizzleService) {}

  async getGrants(userId: string): Promise<AdminGrant[] | null> {
    const db = this.drizzle.db;
    // Resolve tenant per call - factories run once at boot outside any request
    // ALS frame, so a constructor-captured tenant would freeze to 'default'.
    const tenantId = getCurrentTenantId() ?? 'default';

    const assignments = await db
      .select({ roleId: adminRoleAssignment.roleId })
      .from(adminRoleAssignment)
      .where(
        and(eq(adminRoleAssignment.userId, userId), eq(adminRoleAssignment.tenantId, tenantId)),
      );

    if (assignments.length === 0) {
      return null;
    }

    const roleIds = assignments.map((a) => a.roleId);

    // Collect grants for all assigned roles.
    const rows = await Promise.all(
      roleIds.map((roleId) =>
        db
          .select({
            resource: adminRolePermission.resource,
            action: adminRolePermission.action,
          })
          .from(adminRolePermission)
          .where(eq(adminRolePermission.roleId, roleId)),
      ),
    );

    return rows.flat().map((r) => ({ resource: r.resource, action: r.action }));
  }
}

export class IamService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly email: SendEmailPort,
  ) {}

  // Resolve the tenant per call - never in the constructor. Factories run once at
  // app assembly (outside any request ALS frame) and the Container caches the
  // result, so a captured tenant would freeze to 'default' for every tenant.
  private tenant(): string {
    return getCurrentTenantId() ?? 'default';
  }

  // The caller's EFFECTIVE grants: DB-backed assignment if present, otherwise the
  // static grants for their `user.role` (the bootstrap admin has no DB row). Used
  // for the no-escalation subset check below.
  private async callerGrants(caller: { userId: string; role: string }): Promise<AdminGrant[]> {
    const resolver = new DbAdminPermissionResolver(this.drizzle);
    const dbGrants = await resolver.getGrants(caller.userId);
    return dbGrants ?? staticGrantsForRole(caller.role);
  }

  listCatalog(): CatalogEntry[] {
    return buildCatalog();
  }

  async listRoles(): Promise<AdminRole[]> {
    const rows = await this.drizzle.db
      .select()
      .from(adminRole)
      .where(eq(adminRole.tenantId, this.tenant()));
    return rows.map(toRoleDto);
  }

  async getRole(roleId: string): Promise<AdminRoleWithGrants> {
    const tenantId = this.tenant();
    const row = findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(adminRole)
        .where(and(eq(adminRole.id, roleId), eq(adminRole.tenantId, tenantId))),
      new RoleNotFoundError(roleId),
    );
    const permissions = await this.drizzle.db
      .select()
      .from(adminRolePermission)
      .where(eq(adminRolePermission.roleId, roleId));
    return {
      ...toRoleDto(row),
      permissions: permissions.map(toPermissionDto),
    };
  }

  async createRole(input: { name: string; description?: string }): Promise<AdminRole> {
    const [row] = await this.drizzle.db
      .insert(adminRole)
      .values({
        tenantId: this.tenant(),
        name: input.name,
        description: input.description ?? null,
      })
      .returning();
    return toRoleDto(row!);
  }

  async updateRole(input: {
    roleId: string;
    name?: string;
    description?: string | null;
  }): Promise<AdminRole> {
    const tenantId = this.tenant();
    findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(adminRole)
        .where(and(eq(adminRole.id, input.roleId), eq(adminRole.tenantId, tenantId))),
      new RoleNotFoundError(input.roleId),
    );

    const patch: Partial<typeof adminRole.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;

    const [row] = await this.drizzle.db
      .update(adminRole)
      .set(patch)
      .where(and(eq(adminRole.id, input.roleId), eq(adminRole.tenantId, tenantId)))
      .returning();
    return toRoleDto(row!);
  }

  async deleteRole(roleId: string): Promise<{ success: true }> {
    const tenantId = this.tenant();
    findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(adminRole)
        .where(and(eq(adminRole.id, roleId), eq(adminRole.tenantId, tenantId))),
      new RoleNotFoundError(roleId),
    );
    await this.drizzle.db.delete(adminRolePermission).where(eq(adminRolePermission.roleId, roleId));
    await this.drizzle.db
      .delete(adminRole)
      .where(and(eq(adminRole.id, roleId), eq(adminRole.tenantId, tenantId)));
    return { success: true };
  }

  async setRolePermissions(input: {
    roleId: string;
    grants: ReadonlyArray<{ resource: string; action: string }>;
    caller: { userId: string; role: string };
  }): Promise<AdminRoleWithGrants> {
    const tenantId = this.tenant();
    findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(adminRole)
        .where(and(eq(adminRole.id, input.roleId), eq(adminRole.tenantId, tenantId))),
      new RoleNotFoundError(input.roleId),
    );

    // Reject any (resource, action) not in the catalog.
    validateGrants(input.grants);

    // No-escalation check: a caller may only grant permissions they themselves
    // hold. Without this, any admin:update holder could grant withdrawal:approve,
    // audit:export, etc. to a role (and assign it to themselves).
    const held = await this.callerGrants(input.caller);
    if (!isSubset(input.grants, held)) {
      throw new GrantEscalationError();
    }

    await this.drizzle.db
      .delete(adminRolePermission)
      .where(eq(adminRolePermission.roleId, input.roleId));

    if (input.grants.length > 0) {
      await this.drizzle.db.insert(adminRolePermission).values(
        input.grants.map((g) => ({
          tenantId,
          roleId: input.roleId,
          resource: g.resource,
          action: g.action,
        })),
      );
    }

    return this.getRole(input.roleId);
  }

  async assignRole(input: {
    userId: string;
    roleId: string;
    caller: { userId: string; role: string };
  }): Promise<AdminRoleAssignment> {
    const tenantId = this.tenant();
    findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(adminRole)
        .where(and(eq(adminRole.id, input.roleId), eq(adminRole.tenantId, tenantId))),
      new RoleNotFoundError(input.roleId),
    );

    // No-escalation check: the caller may only assign a role whose grant set is a
    // subset of their own effective grants. Stops an admin:update holder from
    // assigning a more powerful role to anyone (including themselves).
    const roleGrants = await this.drizzle.db
      .select({ resource: adminRolePermission.resource, action: adminRolePermission.action })
      .from(adminRolePermission)
      .where(eq(adminRolePermission.roleId, input.roleId));
    const held = await this.callerGrants(input.caller);
    if (!isSubset(roleGrants, held)) {
      throw new GrantEscalationError();
    }

    const [row] = await this.drizzle.db
      .insert(adminRoleAssignment)
      .values({
        tenantId,
        userId: input.userId,
        roleId: input.roleId,
      })
      .returning();
    return toAssignmentDto(row!);
  }

  async listInvitations(): Promise<AdminInvitation[]> {
    const rows = await this.drizzle.db
      .select()
      .from(adminInvitation)
      .where(eq(adminInvitation.tenantId, this.tenant()));
    return rows.map(toInvitationDto);
  }

  async inviteAdmin(input: { email: string; roleId: string }): Promise<AdminInvitation> {
    const tenantId = this.tenant();
    findOneOrThrow(
      await this.drizzle.db
        .select()
        .from(adminRole)
        .where(and(eq(adminRole.id, input.roleId), eq(adminRole.tenantId, tenantId))),
      new RoleNotFoundError(input.roleId),
    );

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [row] = await this.drizzle.db
      .insert(adminInvitation)
      .values({
        tenantId,
        email: input.email,
        roleId: input.roleId,
        token,
        status: 'pending',
        expiresAt,
      })
      .returning();

    // Side effect: send email after DB write.
    await this.email.send({
      to: input.email,
      subject: 'You have been invited as an administrator',
      body: `Your admin invitation token: ${token}. It expires at ${expiresAt.toISOString()}.`,
    });

    return toInvitationDto(row!);
  }

  async acceptInvitation(token: string): Promise<{ success: true; email: string }> {
    // Single atomic conditional UPDATE - the predicate (pending + not expired) is
    // evaluated by the DB under the row lock, so two concurrent accepts cannot both
    // succeed. Zero returned rows means already-consumed, expired, or unknown token.
    // Public/unauthenticated path: tenant scoping is derived from the row, not the
    // request, so no tenant predicate is applied here.
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

    // Emit ONLY when a row was actually transitioned, so a replayed accept never
    // double-provisions. Tenant scoping for follow-on work derives from the row.
    this.events.emit('iam.invitation.accepted', {
      email: row.email,
      roleId: row.roleId,
      invitationId: row.id,
    });

    return { success: true, email: row.email };
  }
}
