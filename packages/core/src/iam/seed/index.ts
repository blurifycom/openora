import type { DrizzleDb } from '@blurifycom/core/server';
import { seedRoles } from './seed-default-roles.js';

export async function seedIam(db: DrizzleDb): Promise<void> {
  await seedRoles(db);
}
