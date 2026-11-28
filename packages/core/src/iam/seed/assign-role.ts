import { eq } from 'drizzle-orm';
import { findOneOrThrow, type DrizzleDb } from '@openora/core/server';
import { adminRole, adminRoleAssignment } from '../schema/index.js';

export async function assignRoleByKey(
  db: DrizzleDb,
  userId: string,
  roleKey: string,
): Promise<void> {
  const role = findOneOrThrow(
    await db.select({ id: adminRole.id }).from(adminRole).where(eq(adminRole.key, roleKey)),
    new Error(`No admin role with key '${roleKey}' - run seedIam first`),
  );
  await db.insert(adminRoleAssignment).values({ userId, roleId: role.id }).onConflictDoNothing();
}
