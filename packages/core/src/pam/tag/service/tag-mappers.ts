import type { TagRule, TagKey } from '@openora/core/contracts';
import { serializeRow } from '@openora/core/server';
import type { PlayerTagWithTag } from '../contract/index.js';
import { tag, playerTag, tagRule } from '../schema/index.js';

export function toTag(row: typeof tag.$inferSelect) {
  return serializeRow(row, { dateFields: ['createdAt', 'updatedAt'] });
}

export function toPlayerTagWithTag(
  pt: typeof playerTag.$inferSelect,
  tagKey: TagKey,
): PlayerTagWithTag {
  return {
    id: pt.id,
    playerId: pt.playerId,
    tagId: pt.tagId,
    assignReason: pt.assignReason,
    assignActor: pt.assignActor,
    assignActorUserId: pt.assignActorUserId ?? null,
    assignMetadata: pt.assignMetadata ?? null,
    removedAt: pt.removedAt ?? null,
    removalReason: pt.removalReason ?? null,
    removalActor: pt.removalActor ?? null,
    removalActorUserId: pt.removalActorUserId ?? null,
    createdAt: pt.createdAt.toISOString(),
    updatedAt: pt.updatedAt.toISOString(),
    tag: { key: tagKey },
  };
}

export function toTagRule(row: typeof tagRule.$inferSelect & { tagKey: TagKey }): TagRule {
  return {
    id: row.id,
    tagId: row.tagId,
    tagKey: row.tagKey,
    isEnabled: row.isEnabled,
    threshold: row.threshold,
    thresholdDays: row.thresholdDays ?? null,
    thresholdCount: row.thresholdCount ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
