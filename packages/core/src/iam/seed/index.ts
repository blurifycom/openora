import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@blurifycom/core/server';
import { adminRole, adminRolePermission } from '../schema/index.js';
import { DEFAULT_ADMIN_ROLES } from './default-admin-roles.js';

/**
 * Idempotently seeds the predefined backoffice roles and their permission grants
 * from the canonical DEFAULT_ADMIN_ROLES spec. Convergent: re-running reconciles
 * changed names/levels via upsert, so editing the spec and re-seeding propagates
 * to existing databases. Does NOT remove grants dropped from the spec.
 */
export async function seedRoles(db: DrizzleDb): Promise<void> {
  await db
    .insert(adminRole)
    .values(
      DEFAULT_ADMIN_ROLES.map((r) => ({
        key: r.key,
        name: r.name,
        isSystem: r.isSystem,
        isSuperAdmin: r.isSuperAdmin,
      })),
    )
    .onConflictDoUpdate({
      target: adminRole.key,
      set: {
        name: sql`excluded.name`,
        isSystem: sql`excluded."isSystem"`,
        isSuperAdmin: sql`excluded."isSuperAdmin"`,
      },
    });

  const existing = await db.select({ id: adminRole.id, key: adminRole.key }).from(adminRole);
  const roleByKey = new Map(existing.map((r) => [r.key, r.id]));

  // Super-admin bypasses authz, so it stores no permission rows.
  const permissionRows = DEFAULT_ADMIN_ROLES.filter((r) => !r.isSuperAdmin).flatMap((r) => {
    const roleId = roleByKey.get(r.key);
    if (!roleId) return [];
    return Object.entries(r.matrix)
      .filter(([, level]) => level !== 'no_access')
      .map(([resource, level]) => ({ roleId, resource, level }));
  });

  if (permissionRows.length > 0) {
    await db
      .insert(adminRolePermission)
      .values(permissionRows)
      .onConflictDoUpdate({
        target: [adminRolePermission.roleId, adminRolePermission.resource],
        set: { level: sql`excluded.level`, updatedAt: sql`now()` },
      });
  }
}
