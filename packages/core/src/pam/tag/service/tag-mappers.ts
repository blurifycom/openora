import type { Tag, TagRule, TagKey } from '@openora/core/contracts';
import type { PlayerTagWithTag } from '../contract/index.js';
import { tag, playerTag, tagRule } from '../schema/index.js';

export function toTag(row: typeof tag.$inferSelect): Tag {
  return {
    id: row.id,
    key: row.key,
    isSticky: row.isSticky,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    thresholdAmount: row.thresholdAmount === null ? null : Number(row.thresholdAmount),
    thresholdDays: row.thresholdDays ?? null,
    thresholdCount: row.thresholdCount ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
