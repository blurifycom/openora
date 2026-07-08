import type { DrizzleDb } from '@blurifycom/core/server';
import { seedTags } from './seed-default-tags.js';
import { seedTagRules } from './seed-default-tag-rules.js';

export async function seedTag(db: DrizzleDb): Promise<void> {
  await seedTags(db);
  await seedTagRules(db);
}
