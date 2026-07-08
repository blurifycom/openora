import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@blurifycom/core/server';
import { tag, tagRule } from '../schema/index.js';
import { DEFAULT_TAG_RULES } from './data/default-tag-rules.js';

/** Idempotently seeds the default tag rules. Re-running updates isEnabled; thresholds are not overwritten so operator values are preserved. */
export async function seedTagRules(db: DrizzleDb): Promise<void> {
  const tags = await db.select({ id: tag.id, key: tag.key }).from(tag);
  const tagIdByKey = new Map(tags.map((t) => [t.key, t.id]));

  const rows = DEFAULT_TAG_RULES.flatMap((r) => {
    const tagId = tagIdByKey.get(r.tagKey);
    if (!tagId) return [];
    return [
      {
        tagId,
        isEnabled: r.isEnabled,
        thresholdAmount: r.thresholdAmount?.toString() ?? null,
        thresholdDays: r.thresholdDays,
        thresholdCount: r.thresholdCount,
      },
    ];
  });

  if (rows.length === 0) return;

  await db
    .insert(tagRule)
    .values(rows)
    .onConflictDoUpdate({
      target: tagRule.tagId,
      set: { updatedAt: sql`now()` },
    });
}
