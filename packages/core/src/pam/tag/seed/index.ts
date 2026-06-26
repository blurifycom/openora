import type { DrizzleDb } from '@blurifycom/core/server';
import { seedTags } from './seed-default-tags.js';

export async function seedTag(db: DrizzleDb): Promise<void> {
  await seedTags(db);
}
