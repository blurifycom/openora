import {
  holdsGrant,
  levelToActions,
  statement,
  type DrizzleDb,
  type DrizzleTx,
  type PermissionLevel,
  type ResourceName,
} from '@openora/core/server';
import { eq, inArray } from 'drizzle-orm';
import type { AdminGrant, User } from '@openora/core/contracts';
// Read-only cross-domain schema import (sanctioned): the grant rule falls back to `user.role`.
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRolePermission, adminRoleAssignment } from '../schema/index.js';

function allGrants() {
  return (Object.keys(statement) as ResourceName[]).flatMap((resource) =>
    (statement[resource] as readonly string[]).map((action) => ({
      resource: resource as string,
      action,
    })),
  );
}

type AssignedGrantRow = {
  isSuperAdmin: boolean;
  resource: string | null;
  level: PermissionLevel | null;
};

function grantsOf(rows: readonly AssignedGrantRow[]): AdminGrant[] {
  if (rows.some((r) => r.isSuperAdmin)) {
    return allGrants();
  }
  const seen = new Set<string>();
  const grants: AdminGrant[] = [];
  for (const { resource, level } of rows) {
    if (!resource || !level) {
      continue;
    }
    for (const action of levelToActions(resource, level)) {
      const key = `${resource}:${action}`;
      if (!seen.has(key)) {
        seen.add(key);
        grants.push({ resource, action });
      }
    }
  }
  return grants;
}

/**
 * The DB grants of each of `userIds` holding a role assignment, read through `db` - a
 * transaction included - without the grant cache. A user with no assignment is absent, which is
 * AdminGuard's cue to fall back to the static role table.
 */
export async function loadAdminGrants(db: DrizzleDb | DrizzleTx, userIds: readonly User['id'][]) {
  const rows = await db
    .select({
      userId: adminRoleAssignment.userId,
      isSuperAdmin: adminRole.isSuperAdmin,
      resource: adminRolePermission.resource,
      level: adminRolePermission.level,
    })
    .from(adminRoleAssignment)
    .innerJoin(adminRole, eq(adminRole.id, adminRoleAssignment.roleId))
    .leftJoin(adminRolePermission, eq(adminRolePermission.roleId, adminRole.id))
    .where(inArray(adminRoleAssignment.userId, [...userIds]));

  const rowsByUser = new Map<User['id'], AssignedGrantRow[]>();
  for (const { userId, ...row } of rows) {
    const userRows = rowsByUser.get(userId) ?? [];
    userRows.push(row);
    rowsByUser.set(userId, userRows);
  }
  return new Map([...rowsByUser].map(([userId, userRows]) => [userId, grantsOf(userRows)]));
}

/** Of `userIds`, those AdminGuard's grant rule refuses `mcp-access:use`, read uncached through `db`. */
export async function usersWithoutMcpAccess(
  db: DrizzleDb | DrizzleTx,
  userIds: readonly User['id'][],
) {
  const accounts = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(inArray(user.id, [...userIds]));
  const grants = await loadAdminGrants(db, userIds);
  const roleOf = new Map(accounts.map((account) => [account.id, account.role]));
  return userIds.filter((userId) => {
    const role = roleOf.get(userId);
    return (
      role === undefined ||
      !holdsGrant({ role, grants: grants.get(userId) ?? null }, 'mcp-access', 'use')
    );
  });
}
