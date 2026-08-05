import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeEventBus, makeAdminGuard, testContext } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { tag, tagRule, playerTag } from '../schema/index.js';
import { createTagRouter } from '../router/index.js';
import { TagService } from '../service/tag.service.js';
import { TagRuleService } from '../service/tag-rule.service.js';

const UID = '11111111-1111-4111-8111-111111111111';
const CALLER = '55555555-5555-4555-8555-555555555555';

const CTX = testContext();
const AUTHED_CTX = testContext({ auth: { userId: CALLER } });

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

const denyingGuard = () => makeAdminGuard({ allow: [] });

const allowingGuard = () => makeAdminGuard({ caller: { userId: CALLER } });

function build(adminGuard: AdminGuard) {
  const events = makeEventBus();
  const tagService = new TagService(db.drizzle, events);
  const ruleService = new TagRuleService(db.drizzle, events);
  return { router: createTagRouter(tagService, ruleService, adminGuard), events };
}

async function seedTag(key: TagKey) {
  await db.drizzle.db.insert(tag).values({ key });
}

async function storedPlayerTags() {
  return db.drizzle.db.select().from(playerTag);
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

  it('rejects listPlayerTags for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(
      call(router.listPlayerTags, { playerId: UID, page: 1, limit: 20 }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects listAssignableTags for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(
      call(router.listAssignableTags, { playerId: UID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects createTag for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(
      call(router.createTag, { key: 'high_roller', isSticky: false }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects assignPlayerTag for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(
      call(
        router.assignPlayerTag,
        {
          playerId: UID,
          tagKey: 'high_roller',
          assignReason: 'manual review',
          assignActor: 'manual',
        },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects deleteTag for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(
      call(router.deleteTag, { key: 'high_roller' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects removePlayerTag for a non-privileged caller', async () => {
    const { router } = build(denyingGuard());

    await expect(
      call(
        router.removePlayerTag,
        {
          playerId: UID,
          tagKey: 'high_roller',
          removalReason: 'manual review',
          removalActor: 'manual',
        },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
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

describe('tag router error mapping', () => {
  it('maps TagAlreadyInUseError to a CONFLICT response instead of a raw 500', async () => {
    const { router } = build(allowingGuard());
    await seedTag('high_roller');
    const assignInput = {
      playerId: UID,
      tagKey: 'high_roller' as TagKey,
      assignReason: 'manual review',
      assignActor: 'manual' as const,
    };
    await call(router.assignPlayerTag, assignInput, { context: AUTHED_CTX });

    await expect(
      call(router.assignPlayerTag, assignInput, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps TagKeyConflictError (duplicate tag key) to a CONFLICT response', async () => {
    const { router } = build(allowingGuard());
    await call(router.createTag, { key: 'high_roller', isSticky: false }, { context: AUTHED_CTX });

    await expect(
      call(router.createTag, { key: 'high_roller', isSticky: false }, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps TagInUseError (FK-restrict on delete) to a CONFLICT response', async () => {
    const { router } = build(allowingGuard());
    await seedTag('high_roller');
    await call(
      router.assignPlayerTag,
      {
        playerId: UID,
        tagKey: 'high_roller',
        assignReason: 'manual review',
        assignActor: 'manual',
      },
      { context: AUTHED_CTX },
    );

    await expect(
      call(router.deleteTag, { key: 'high_roller' }, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps TagNotFoundError (deleting a nonexistent key) to a NOT_FOUND response', async () => {
    const { router } = build(allowingGuard());

    await expect(
      call(router.deleteTag, { key: 'high_roller' }, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('tag router player-tag removal', () => {
  it('normalizes the removal reason before persistence and audit emission', async () => {
    await seedTag('high_roller');
    const { router, events } = build(allowingGuard());
    const assignInput = {
      playerId: UID,
      tagKey: 'high_roller' as TagKey,
      assignReason: 'manual review',
      assignActor: 'manual' as const,
    };
    await call(router.assignPlayerTag, assignInput, { context: AUTHED_CTX });
    events.emit.mockClear();

    const result = await call(
      router.removePlayerTag,
      {
        playerId: UID,
        tagKey: 'high_roller',
        removalReason: '  cleared after review  ',
        removalActor: 'manual',
      },
      { context: AUTHED_CTX },
    );

    expect(result.removalReason).toBe('cleared after review');
    expect((await storedPlayerTags()).at(0)?.removalReason).toBe('cleared after review');
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.removed',
      expect.objectContaining({ reason: 'cleared after review' }),
    );
  });

  it('rejects a whitespace-only removal reason at the API boundary', async () => {
    await seedTag('high_roller');
    const { router } = build(allowingGuard());

    await expect(
      call(
        router.removePlayerTag,
        {
          playerId: UID,
          tagKey: 'high_roller',
          removalReason: '   ',
          removalActor: 'manual',
        },
        { context: AUTHED_CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await storedPlayerTags()).toHaveLength(0);
  });

  it('requires a reason when removing a sticky tag', async () => {
    await db.drizzle.db.insert(tag).values({ key: 'vip', isSticky: true });
    const { router } = build(allowingGuard());
    await call(
      router.assignPlayerTag,
      {
        playerId: UID,
        tagKey: 'vip',
        assignReason: 'manual review',
        assignActor: 'manual',
      },
      { context: AUTHED_CTX },
    );

    await expect(
      call(
        router.removePlayerTag,
        { playerId: UID, tagKey: 'vip', removalActor: 'manual' },
        { context: AUTHED_CTX },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await storedPlayerTags()).at(0)?.removedAt).toBeNull();
  });

  it('allows removing a non-sticky tag without a reason', async () => {
    await seedTag('high_roller');
    const { router, events } = build(allowingGuard());
    await call(
      router.assignPlayerTag,
      {
        playerId: UID,
        tagKey: 'high_roller',
        assignReason: 'manual review',
        assignActor: 'manual',
      },
      { context: AUTHED_CTX },
    );
    events.emit.mockClear();

    await call(
      router.removePlayerTag,
      { playerId: UID, tagKey: 'high_roller', removalActor: 'manual' },
      { context: AUTHED_CTX },
    );

    expect((await storedPlayerTags()).at(0)?.removalReason).toBe('manual tag removal');
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.removed',
      expect.objectContaining({ reason: 'manual tag removal' }),
    );
  });
});
