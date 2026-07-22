import { DrizzleService, EventBus, findOneOrThrow, makeNotFoundError } from '@openora/core/server';
import { type UpsertTagRuleInput, type TagKey, type User } from '@openora/core/contracts';
import { asc, eq } from 'drizzle-orm';
import { tag, tagRule } from '../schema/index.js';
import { toTagRule } from './tag-mappers.js';

export const TagRuleNotFoundError = makeNotFoundError('TagRule');

export class TagRuleService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async listTagRules() {
    const rows = await this.drizzle.db
      .select({
        id: tagRule.id,
        tagId: tagRule.tagId,
        isEnabled: tagRule.isEnabled,
        threshold: tagRule.threshold,
        thresholdDays: tagRule.thresholdDays,
        thresholdCount: tagRule.thresholdCount,
        createdAt: tagRule.createdAt,
        updatedAt: tagRule.updatedAt,
        tagKey: tag.key,
      })
      .from(tagRule)
      .innerJoin(tag, eq(tagRule.tagId, tag.id))
      .orderBy(asc(tag.key));
    return rows.map(toTagRule);
  }

  async getTagRule(tagKey: TagKey) {
    const results = await this.drizzle.db
      .select({
        id: tagRule.id,
        tagId: tagRule.tagId,
        isEnabled: tagRule.isEnabled,
        threshold: tagRule.threshold,
        thresholdDays: tagRule.thresholdDays,
        thresholdCount: tagRule.thresholdCount,
        createdAt: tagRule.createdAt,
        updatedAt: tagRule.updatedAt,
        tagKey: tag.key,
      })
      .from(tagRule)
      .innerJoin(tag, eq(tagRule.tagId, tag.id))
      .where(eq(tag.key, tagKey))
      .limit(1);
    return toTagRule(findOneOrThrow(results, new TagRuleNotFoundError(tagKey)));
  }

  async upsertTagRule(
    input: UpsertTagRuleInput,
    actorId: User['id'],
    meta?: { ip?: string | null; userAgent?: string | null },
  ) {
    const tagRow = findOneOrThrow(
      await this.drizzle.db
        .select({ id: tag.id })
        .from(tag)
        .where(eq(tag.key, input.tagKey))
        .limit(1),
      new TagRuleNotFoundError(input.tagKey),
    );

    const values = {
      tagId: tagRow.id,
      isEnabled: input.isEnabled,
      threshold: input.threshold,
      thresholdDays: input.thresholdDays,
      thresholdCount: input.thresholdCount,
    };
    // Exclude the conflict-target column from the update set.
    const { tagId: _id, ...updateValues } = values;
    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(tagRule)
        .values(values)
        .onConflictDoUpdate({ target: tagRule.tagId, set: updateValues })
        .returning(),
      new TagRuleNotFoundError(input.tagKey),
    );
    const result = toTagRule({ ...row, tagKey: input.tagKey });
    void this.events.emit('tag.rule.upserted', {
      tagKey: input.tagKey,
      actorId,
      after: result,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return result;
  }
}
