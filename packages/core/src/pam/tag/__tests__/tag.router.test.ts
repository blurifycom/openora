import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard, EventBus } from '@openora/core/server';
import type { TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEvents, adminCaller, testContext } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { tag, tagRule, playerTag } from '../schema/index.js';
import { createTagRouter } from '../router/index.js';
import { TagService } from '../service/tag.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';

const CTX = testContext();
const CALLER = '55555555-5555-4555-8555-555555555555';

const RULE_INPUT = {
  tagKey: 'high_roller' as TagKey,
  isEnabled: true,
  threshold: '1000',
  thresholdDays: null,
  thresholdCount: null,
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tagRule}, ${tag} RESTART IDENTITY CASCADE`,
  );
});

function denyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async () => {
      throw new ORPCError('FORBIDDEN', { message: 'Missing permission: tag-rule' });
    }),
  });
}

function allowingGuard(): AdminGuard {
  return mock<AdminGuard>({ assert: vi.fn(async () => adminCaller({ userId: CALLER })) });
}

function build(adminGuard: AdminGuard) {
  const events = makeEvents();
  const tagService = new TagService(db.drizzle, mock<EventBus>(events));
  const ruleService = new TagRuleService(db.drizzle, mock<EventBus>(events));
  return { router: createTagRouter(tagService, ruleService, adminGuard), events };
}

async function seedTag(key: TagKey) {
  await db.drizzle.db.insert(tag).values({ key });
}

async function storedRules() {
  return db.drizzle.db.select().from(tagRule);
}

describe('tag router authz', () => {
  it('rejects listTagRules for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(call(router.listTagRules, {}, { context: CTX })).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects upsertTagRule for a non-privileged caller and writes nothing', async () => {
    await seedTag('high_roller');
    const { router } = build(denyingGuard());

    await expect(call(router.upsertTagRule, RULE_INPUT, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
    expect(await storedRules()).toHaveLength(0);
  });
});

describe('tag router rule administration', () => {
  it('upsertTagRule persists the rule against the caller as actor', async () => {
    await seedTag('high_roller');
    const { router } = build(allowingGuard());

    const result = await call(router.upsertTagRule, RULE_INPUT, { context: CTX });

    expect(result.tagKey).toBe('high_roller');
    const stored = await storedRules();
    expect(stored).toHaveLength(1);
    expect(Number(stored[0]?.threshold)).toBe(1000);
  });

  it('upsertTagRule updates the existing rule rather than adding a second one', async () => {
    await seedTag('high_roller');
    const { router } = build(allowingGuard());
    await call(router.upsertTagRule, RULE_INPUT, { context: CTX });

    await call(router.upsertTagRule, { ...RULE_INPUT, threshold: '5000' }, { context: CTX });

    const stored = await storedRules();
    expect(stored).toHaveLength(1);
    expect(Number(stored[0]?.threshold)).toBe(5000);
  });

  it('listTagRules returns the rules the router just wrote', async () => {
    await seedTag('high_roller');
    const { router } = build(allowingGuard());
    await call(router.upsertTagRule, RULE_INPUT, { context: CTX });

    const rules = await call(router.listTagRules, {}, { context: CTX });

    expect(rules).toHaveLength(1);
    expect(rules[0]?.tagKey).toBe('high_roller');
  });

  it('rejects a rule for a tag that does not exist', async () => {
    const { router } = build(allowingGuard());

    await expect(call(router.upsertTagRule, RULE_INPUT, { context: CTX })).rejects.toThrow();
    expect(await storedRules()).toHaveLength(0);
  });
});
