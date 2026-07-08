import { DrizzleService, EventBus, makeNotFoundError } from '@openora/core/server';
import { type UpsertTagRuleInput, type TagKey, type TagRule } from '@openora/core/contracts';
import { asc, eq } from 'drizzle-orm';
import { tag, tagRule } from '../schema/index.js';
import { toTagRule } from './tag-mappers.js';

export const TagRuleNotFoundError = makeNotFoundError('TagRule');

export class TagRuleService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async listTagRules(): Promise<TagRule[]> {
    const rows = await this.drizzle.db
      .select({
        id: tagRule.id,
        tagId: tagRule.tagId,
        isEnabled: tagRule.isEnabled,
        thresholdAmount: tagRule.thresholdAmount,
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

  async getTagRule(tagKey: TagKey): Promise<TagRule> {
    const results = await this.drizzle.db
      .select({
        id: tagRule.id,
        tagId: tagRule.tagId,
        isEnabled: tagRule.isEnabled,
        thresholdAmount: tagRule.thresholdAmount,
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
    const [row] = results;
    if (!row) throw new TagRuleNotFoundError(tagKey);
    return toTagRule(row);
  }

  async upsertTagRule(input: UpsertTagRuleInput, actorId: string): Promise<TagRule> {
    const [tagRow] = await this.drizzle.db
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.key, input.tagKey))
      .limit(1);
    if (!tagRow) throw new TagRuleNotFoundError(input.tagKey);

    // decimal() columns require string on write; z.coerce.number() on the contract coerces back on read.
    const values = {
      tagId: tagRow.id,
      isEnabled: input.isEnabled,
      thresholdAmount: input.thresholdAmount?.toString() ?? null,
      thresholdDays: input.thresholdDays,
      thresholdCount: input.thresholdCount,
    };
    // Exclude the conflict-target column from the update set.
    const { tagId: _id, ...updateValues } = values;
    const [row] = await this.drizzle.db
      .insert(tagRule)
      .values(values)
      .onConflictDoUpdate({ target: tagRule.tagId, set: updateValues })
      .returning();
    const result = toTagRule({ ...row!, tagKey: input.tagKey });
    void this.events.emit('tag.rule.upserted', { tagKey: input.tagKey, actorId, after: result });
    return result;
  }
}
