import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb } from '../../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import { TagRuleService, TagRuleNotFoundError } from '../service/tag-rule.service.js';
import type { TagRule } from '../schema/index.js';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const TAG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type TagRuleWithKey = TagRule & { tagKey: string };

function makeRow(overrides: Partial<TagRuleWithKey> = {}): TagRuleWithKey {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    tagId: TAG_ID,
    tagKey: 'high_roller',
    isEnabled: true,
    thresholdAmount: '1000',
    thresholdDays: null,
    thresholdCount: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  } as TagRuleWithKey;
}

/** Mirrors what toTagRule does: dates -> ISO strings, decimal string -> number. */
function mapped(row: TagRuleWithKey) {
  return {
    id: row.id,
    tagId: row.tagId,
    tagKey: row.tagKey,
    isEnabled: row.isEnabled,
    thresholdAmount: row.thresholdAmount === null ? null : Number(row.thresholdAmount),
    thresholdDays: row.thresholdDays,
    thresholdCount: row.thresholdCount,
    createdAt: (row.createdAt as unknown as Date).toISOString(),
    updatedAt: (row.updatedAt as unknown as Date).toISOString(),
  };
}

function makeEvents() {
  return mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
}

/**
 * For listTagRules / getTagRule: select with innerJoin.
 * Chain: select() -> from() -> innerJoin() -> orderBy() / where() -> limit()
 */
function makeQueryDb(ruleRows: unknown[] = []) {
  const limit = vi.fn().mockResolvedValue(ruleRows);
  const where = vi.fn(() => ({ limit }));
  const orderBy = vi.fn().mockResolvedValue(ruleRows);
  const innerJoin = vi.fn(() => ({ where, orderBy }));
  const from = vi.fn(() => Object.assign(Promise.resolve(ruleRows), { innerJoin }));
  const select = vi.fn(() => ({ from }));

  const db = { select, from, innerJoin, where, limit, orderBy };
  return { drizzle: mockDb(db), db };
}

/**
 * For upsertTagRule: tag lookup (select -> from -> where -> limit) then insert chain.
 * Pass tagId=null to simulate a missing tag row.
 */
function makeUpsertDb(tagId: string | null, returningResult: unknown[] = []) {
  const tagLimit = vi.fn().mockResolvedValue(tagId ? [{ id: tagId }] : []);
  const tagWhere = vi.fn(() => ({ limit: tagLimit }));
  const tagFrom = vi.fn(() => ({ where: tagWhere }));
  const select = vi.fn(() => ({ from: tagFrom }));

  const returning = vi.fn().mockResolvedValue(returningResult);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  const db = { select, insert, values, onConflictDoUpdate, returning, tagWhere, tagLimit };
  return { drizzle: mockDb(db), db };
}

describe('TagRuleService', () => {
  describe('listTagRules', () => {
    it('returns rows joined with tag key, ordered by tag key', async () => {
      const rows = [makeRow(), makeRow({ tagKey: 'inactive', thresholdAmount: null })];
      const { drizzle } = makeQueryDb(rows);
      const svc = new TagRuleService(drizzle, makeEvents());
      expect(await svc.listTagRules()).toEqual(rows.map(mapped));
    });
  });

  describe('getTagRule', () => {
    it('returns the matching joined row', async () => {
      const row = makeRow();
      const { drizzle } = makeQueryDb([row]);
      const svc = new TagRuleService(drizzle, makeEvents());
      expect(await svc.getTagRule('high_roller')).toEqual(mapped(row));
    });

    it('throws TagRuleNotFoundError when no row is found', async () => {
      const { drizzle } = makeQueryDb([]);
      const svc = new TagRuleService(drizzle, makeEvents());
      await expect(svc.getTagRule('high_roller')).rejects.toBeInstanceOf(TagRuleNotFoundError);
    });
  });

  describe('upsertTagRule', () => {
    it('upserts and returns the row with tagKey, stringifying thresholdAmount and excluding tagId from the update set', async () => {
      const row = makeRow();
      const { drizzle, db } = makeUpsertDb(TAG_ID, [row]);
      const svc = new TagRuleService(drizzle, makeEvents());

      const result = await svc.upsertTagRule(
        {
          tagKey: 'high_roller',
          isEnabled: true,
          thresholdAmount: 1000,
          thresholdDays: null,
          thresholdCount: null,
        },
        ACTOR_ID,
      );

      expect(result).toEqual(mapped(row));
      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({ tagId: TAG_ID, thresholdAmount: '1000' }),
      );
      // tagId must not appear in the update set (it is the conflict target)
      expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.not.objectContaining({ tagId: expect.anything() }),
        }),
      );
      expect(db.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: expect.objectContaining({ thresholdAmount: '1000' }) }),
      );
    });

    it('writes null thresholdAmount when omitted', async () => {
      const row = makeRow({ thresholdAmount: null });
      const { drizzle, db } = makeUpsertDb(TAG_ID, [row]);
      const svc = new TagRuleService(drizzle, makeEvents());

      await svc.upsertTagRule(
        {
          tagKey: 'inactive',
          isEnabled: true,
          thresholdAmount: null,
          thresholdDays: 30,
          thresholdCount: null,
        },
        ACTOR_ID,
      );

      expect(db.values).toHaveBeenCalledWith(expect.objectContaining({ thresholdAmount: null }));
    });

    it('throws TagRuleNotFoundError when no tag row exists for the given key', async () => {
      const { drizzle } = makeUpsertDb(null);
      const svc = new TagRuleService(drizzle, makeEvents());
      await expect(
        svc.upsertTagRule(
          {
            tagKey: 'high_roller',
            isEnabled: true,
            thresholdAmount: null,
            thresholdDays: null,
            thresholdCount: null,
          },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(TagRuleNotFoundError);
    });

    it('emits tag.rule.upserted after a successful write', async () => {
      const row = makeRow();
      const { drizzle } = makeUpsertDb(TAG_ID, [row]);
      const events = makeEvents();
      const svc = new TagRuleService(drizzle, events);

      await svc.upsertTagRule(
        {
          tagKey: 'high_roller',
          isEnabled: true,
          thresholdAmount: 1000,
          thresholdDays: null,
          thresholdCount: null,
        },
        ACTOR_ID,
      );

      expect(events.emit).toHaveBeenCalledWith(
        'tag.rule.upserted',
        expect.objectContaining({ tagKey: 'high_roller', actorId: ACTOR_ID }),
      );
    });
  });
});
