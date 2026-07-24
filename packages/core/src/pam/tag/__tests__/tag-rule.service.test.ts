import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import type { TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { tag, tagRule } from '../schema/index.js';
import { TagRuleService, TagRuleNotFoundError } from '../service/tag-rule.service.js';

let db: TestDb;

function makeService() {
  const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
  return { svc: new TagRuleService(db.drizzle, events), events };
}

async function seedTag(key: TagKey) {
  const [row] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return row!;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${tagRule}, ${tag} RESTART IDENTITY CASCADE`);
});

describe('TagRuleService.upsertTagRule (real PG)', () => {
  it('inserts the rule, writes the decimal threshold, and emits upserted', async () => {
    const { svc, events } = makeService();
    const t = await seedTag('high_roller');
    const actorId = randomUUID();

    const rule = await svc.upsertTagRule(
      {
        tagKey: 'high_roller',
        isEnabled: true,
        threshold: '1000',
        thresholdDays: null,
        thresholdCount: null,
      },
      actorId,
    );

    expect(rule).toMatchObject({ tagKey: 'high_roller', isEnabled: true, tagId: t.id });
    expect(Number(rule.threshold)).toBe(1000);
    expect(events.emit).toHaveBeenCalledWith(
      'tag.rule.upserted',
      expect.objectContaining({ tagKey: 'high_roller', actorId }),
    );
  });

  it('updates the existing rule in place rather than adding a second one', async () => {
    const { svc } = makeService();
    await seedTag('high_roller');
    const actorId = randomUUID();
    const first = await svc.upsertTagRule(
      {
        tagKey: 'high_roller',
        isEnabled: false,
        threshold: '1000',
        thresholdDays: null,
        thresholdCount: null,
      },
      actorId,
    );

    const updated = await svc.upsertTagRule(
      {
        tagKey: 'high_roller',
        isEnabled: true,
        threshold: '2500',
        thresholdDays: null,
        thresholdCount: null,
      },
      actorId,
    );

    expect(updated.id).toBe(first.id);
    expect(updated.isEnabled).toBe(true);
    expect(Number(updated.threshold)).toBe(2500);
    expect(await db.drizzle.db.select().from(tagRule)).toHaveLength(1);
  });

  it('writes a null threshold when the rule does not use one', async () => {
    const { svc } = makeService();
    await seedTag('inactive');

    const rule = await svc.upsertTagRule(
      {
        tagKey: 'inactive',
        isEnabled: true,
        threshold: null,
        thresholdDays: 30,
        thresholdCount: null,
      },
      randomUUID(),
    );

    expect(rule).toMatchObject({ threshold: null, thresholdDays: 30 });
  });

  it('throws TagRuleNotFoundError when the tag key has no tag row', async () => {
    const { svc, events } = makeService();

    await expect(
      svc.upsertTagRule(
        {
          tagKey: 'vip',
          isEnabled: true,
          threshold: null,
          thresholdDays: null,
          thresholdCount: null,
        },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(TagRuleNotFoundError);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('TagRuleService.getTagRule (real PG)', () => {
  it('returns the rule joined with its tag key', async () => {
    const { svc } = makeService();
    await seedTag('high_risk');
    await svc.upsertTagRule(
      {
        tagKey: 'high_risk',
        isEnabled: true,
        threshold: '500',
        thresholdDays: 7,
        thresholdCount: 3,
      },
      randomUUID(),
    );

    const rule = await svc.getTagRule('high_risk');

    expect(rule).toMatchObject({
      tagKey: 'high_risk',
      isEnabled: true,
      thresholdDays: 7,
      thresholdCount: 3,
    });
  });

  it('throws TagRuleNotFoundError when the tag carries no rule', async () => {
    const { svc } = makeService();
    await seedTag('vip');

    await expect(svc.getTagRule('vip')).rejects.toBeInstanceOf(TagRuleNotFoundError);
  });
});

describe('TagRuleService.listTagRules (real PG)', () => {
  it('returns every rule ordered by the tag_key enum position, not alphabetically', async () => {
    const { svc } = makeService();
    const actorId = randomUUID();
    for (const tagKey of ['vip', 'high_roller', 'inactive'] as const) {
      await seedTag(tagKey);
      await svc.upsertTagRule(
        { tagKey, isEnabled: true, threshold: null, thresholdDays: null, thresholdCount: null },
        actorId,
      );
    }

    const rules = await svc.listTagRules();

    expect(rules.map((r) => r.tagKey)).toEqual(['high_roller', 'vip', 'inactive']);
  });

  it('returns an empty list when no rules are configured', async () => {
    const { svc } = makeService();
    await seedTag('vip');

    expect(await svc.listTagRules()).toEqual([]);
  });

  it('drops the rule from the listing once it is deleted', async () => {
    const { svc } = makeService();
    const t = await seedTag('vip');
    await svc.upsertTagRule(
      {
        tagKey: 'vip',
        isEnabled: true,
        threshold: null,
        thresholdDays: null,
        thresholdCount: null,
      },
      randomUUID(),
    );
    await db.drizzle.db.delete(tagRule).where(eq(tagRule.tagId, t.id));

    expect(await svc.listTagRules()).toEqual([]);
  });
});
