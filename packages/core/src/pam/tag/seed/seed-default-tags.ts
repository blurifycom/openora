import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@blurifycom/core/server';
import { tag } from '../schema/index.js';
import { DEFAULT_TAGS } from './data/default-tags.js';
/**
 * Idempotently seeds the predefined player tags.
 * Re-running updates name, color, description and stickiness.
 */
export async function seedTags(db: DrizzleDb): Promise<void> {
  await db
    .insert(tag)
    .values(DEFAULT_TAGS)
    .onConflictDoUpdate({
      target: tag.key,
      set: {
        name: sql`excluded.name`,
        color: sql`excluded.color`,
        description: sql`excluded.description`,
        isSticky: sql`excluded."is_sticky"`,
        updatedAt: sql`now()`,
      },
    });
}
