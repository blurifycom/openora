import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@openora/core/server';
import { tag } from '../schema/index.js';
import { DEFAULT_TAGS } from './data/default-tags.js';
export async function seedTags(db: DrizzleDb): Promise<void> {
  await db
    .insert(tag)
    .values(DEFAULT_TAGS)
    .onConflictDoUpdate({
      target: tag.key,
      set: {
        isSticky: sql`excluded."is_sticky"`,
        updatedAt: sql`now()`,
      },
    });
}
