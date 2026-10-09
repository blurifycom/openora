import type { DrizzleDb } from '@openora/core/server';
import { seedRoles } from './seed-default-roles.js';

export { assignRoleByKey } from './assign-role.js';

export async function seedIam(db: DrizzleDb): Promise<void> {
  await seedRoles(db);
}
