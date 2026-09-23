import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  defineGameCategoryRule,
  createGameCategoryRuleCatalog,
  createGameSortCatalog,
  type AdminGameReporting,
  type GameCategoryRule,
} from '@openora/core/contracts';
import { NO_CLIENT_META, makeEventBus, makeJobQueue } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameRound,
  gameTag,
  gameTagGame,
} from '../schema/index.js';
import { GameSortService } from '../service/game-sort.service.js';
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import { DrizzleAdminGameReporting } from '../admin-reporting.js';
import { createDefaultGameCategoryRules } from '../adapters/rules/index.js';
import {
  GAME_CATEGORY_MEMBERSHIP_QUEUE,
  GAME_CATEGORY_RANK_QUEUE,
  GAME_CATEGORY_RULE_MATCH_MAX,
  SYSTEM_ACTOR_ID,
} from '../contract/index.js';
import {
  GameCategoryService,
  GameCategoryRuleRequiredError,
} from '../service/game-category.service.js';
import {
  GameCategoryMembershipService,
  GameCategoryNotRuleManagedError,
} from '../service/game-category-membership.service.js';
import { GameCategoryMembershipTriggerService } from '../service/game-category-membership-trigger.service.js';
import {
  GameCategoryRuleService,
  GameCategoryRuleInvalidError,
  GameCategoryRuleTooBroadError,
  GameCategoryRuleUnavailableError,
} from '../service/game-category-rule.service.js';

let db: TestDb;

function makeRuleCatalog(extra: Parameters<typeof createGameCategoryRuleCatalog>[0] = []) {
  return createGameCategoryRuleCatalog([
    ...createDefaultGameCategoryRules(db.drizzle, new DrizzleAdminGameReporting(db.drizzle)),
    ...extra,
  ]);
}

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };
const DAY_MS = 24 * 60 * 60 * 1000;

const providers = (...providerIds: string[]) => ({ key: 'providers', params: { providerIds } });
const tags = (...tagIds: string[]) => ({ key: 'tags', params: { tagIds } });
const mostPlayed = (limit: number) => ({ key: 'most_played', params: { periodDays: 7, limit } });

function makeServices(extraRules: Parameters<typeof makeRuleCatalog>[0] = []) {
  const events = makeEventBus();
  const jobQueue = makeJobQueue();
  const rules = new GameCategoryRuleService(db.drizzle, makeRuleCatalog(extraRules));
  const membership = new GameCategoryMembershipService(db.drizzle, events, jobQueue, rules);
  const triggers = new GameCategoryMembershipTriggerService(db.drizzle, events, jobQueue, rules);
  const categories = new GameCategoryService(
    db.drizzle,
    events,
    jobQueue,
    new GameSortService(createGameSortCatalog(createDefaultGameSorts(db.drizzle))),
    rules,
    membership,
  );
  return { rules, membership, triggers, categories, events, jobQueue };
}

async function seedProvider(isActive = true) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive })
    .returning();
  return row!;
}

async function seedTag() {
  const [row] = await db.drizzle.db
    .insert(gameTag)
    .values({ name: `tag-${randomUUID()}` })
    .returning();
  return row!;
}

async function seedGame(
  providerId: string,
  { tagIds = [], ...overrides }: Partial<typeof game.$inferInsert> & { tagIds?: string[] } = {},
) {
  const [row] = await db.drizzle.db
    .insert(game)
    .values({
      name: 'Game',
      slug: `game-${randomUUID()}`,
      providerId,
      aggregator: 'direct',
      isActive: true,
      ...overrides,
    })
    .returning();
  if (tagIds.length > 0) {
    await db.drizzle.db
      .insert(gameTagGame)
      .values(tagIds.map((tagId) => ({ gameId: row!.id, tagId })));
  }
  return row!;
}

async function seedRounds(
  gameId: string,
  count: number,
  overrides: Partial<typeof gameRound.$inferInsert> = {},
) {
  await db.drizzle.db.insert(gameRound).values(
    Array.from({ length: count }, () => ({
      gameId,
      userId: randomUUID(),
      status: 'completed' as const,
      betAmount: '100',
      winAmount: '0',
      currency: 'USD',
      startedAt: new Date(Date.now() - DAY_MS),
      ...overrides,
    })),
  );
}

async function seedRuleCategory(rule: GameCategoryRule) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      membershipMode: 'rule',
      membershipRule: rule,
    })
    .returning();
  return row!;
}

async function memberRows(categoryId: string) {
  return db.drizzle.db
    .select({ gameId: gameCategoryGame.gameId, source: gameCategoryGame.source })
    .from(gameCategoryGame)
    .where(eq(gameCategoryGame.categoryId, categoryId));
}

async function memberIds(categoryId: string) {
  return (await memberRows(categoryId)).map((row) => row.gameId).sort();
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${gameTagGame}, ${gameCategoryGame}, ${game}, ${gameTag}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
  );
});

describe('GameCategoryMembershipService.evaluate: rule kinds (real PG)', () => {
  it('providers: materializes every game of the listed providers, playable or not', async () => {
    const { membership } = makeServices();
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const active = await seedGame(listed.id);
    const inactive = await seedGame(listed.id, { isActive: false });
    await seedGame(other.id);
    const category = await seedRuleCategory([providers(listed.id)]);

    const result = await membership.evaluate({ categoryId: category.id, trigger: 'event' });

    expect(result).toMatchObject({ matchedCount: 2, addedCount: 2, removedCount: 0 });
    expect(await memberIds(category.id)).toEqual([active.id, inactive.id].sort());
    expect((await memberRows(category.id)).every((row) => row.source === 'rule')).toBe(true);
  });

  it('tags: matches a game carrying any listed tag', async () => {
    const { membership } = makeServices();
    const provider = await seedProvider();
    const [tagA, tagB, tagC] = [await seedTag(), await seedTag(), await seedTag()];
    const withA = await seedGame(provider.id, { tagIds: [tagA.id] });
    const withBoth = await seedGame(provider.id, { tagIds: [tagA.id, tagB.id] });
    await seedGame(provider.id, { tagIds: [tagC.id] });
    const category = await seedRuleCategory([tags(tagA.id, tagB.id)]);

    await membership.evaluate({ categoryId: category.id, trigger: 'event' });

    expect(await memberIds(category.id)).toEqual([withA.id, withBoth.id].sort());
  });

  it('providers AND tags: a game must satisfy both filters', async () => {
    const { membership } = makeServices();
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const tag = await seedTag();
    const both = await seedGame(listed.id, { tagIds: [tag.id] });
    await seedGame(listed.id);
    await seedGame(other.id, { tagIds: [tag.id] });
    const category = await seedRuleCategory([providers(listed.id), tags(tag.id)]);

    await membership.evaluate({ categoryId: category.id, trigger: 'event' });

    expect(await memberIds(category.id)).toEqual([both.id]);
  });

  it('most played: keeps the N most-played playable games inside the window', async () => {
    const { membership } = makeServices();
    const provider = await seedProvider();
    const most = await seedGame(provider.id);
    const second = await seedGame(provider.id);
    const third = await seedGame(provider.id);
    const stale = await seedGame(provider.id);
    const inactive = await seedGame(provider.id, { isActive: false });
    await seedGame(provider.id);
    await seedRounds(most.id, 5);
    await seedRounds(second.id, 3);
    await seedRounds(third.id, 1);
    await seedRounds(stale.id, 9, { startedAt: new Date(Date.now() - 30 * DAY_MS) });
    await seedRounds(inactive.id, 9);
    const category = await seedRuleCategory([mostPlayed(2)]);

    await membership.evaluate({ categoryId: category.id, trigger: 'schedule' });

    expect(await memberIds(category.id)).toEqual([most.id, second.id].sort());
  });

  it('most played: counts rounds, not money, and never admits a game with no rounds', async () => {
    const { rules } = makeServices();
    const provider = await seedProvider();
    const highStakes = await seedGame(provider.id);
    const popular = await seedGame(provider.id);
    await seedGame(provider.id);
    await seedRounds(highStakes.id, 1, { betAmount: '100000', winAmount: '0' });
    await seedRounds(popular.id, 4, { betAmount: '1', winAmount: '3' });

    expect(await rules.resolveGameIds([mostPlayed(5)])).toEqual([popular.id, highStakes.id]);
  });

  it('most played: a rebound report without a round ranking still drives the rule', async () => {
    const core = new DrizzleAdminGameReporting(db.drizzle);
    const reportOnly: AdminGameReporting = {
      listGamePerformance: (filter) => core.listGamePerformance(filter),
      getGamePerformanceTrend: (filter) => core.getGamePerformanceTrend(filter),
      getPlayerStats: (userId) => core.getPlayerStats(userId),
    };
    const rules = new GameCategoryRuleService(
      db.drizzle,
      createGameCategoryRuleCatalog(createDefaultGameCategoryRules(db.drizzle, reportOnly)),
    );
    const provider = await seedProvider();
    const [most, second, third] = [
      await seedGame(provider.id),
      await seedGame(provider.id),
      await seedGame(provider.id),
    ];
    await seedGame(provider.id);
    await seedRounds(most.id, 3);
    await seedRounds(second.id, 2);
    await seedRounds(third.id, 1);

    expect(await rules.resolveGameIds([mostPlayed(2)])).toEqual([most.id, second.id]);
    expect(await makeServices().rules.resolveGameIds([mostPlayed(2)])).toEqual([
      most.id,
      second.id,
    ]);
  });

  it('most played on top of a filter: ranks only the filtered games', async () => {
    const { membership } = makeServices();
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const inFilter = await seedGame(listed.id);
    const outside = await seedGame(other.id);
    await seedRounds(inFilter.id, 1);
    await seedRounds(outside.id, 9);
    const category = await seedRuleCategory([providers(listed.id), mostPlayed(1)]);

    await membership.evaluate({ categoryId: category.id, trigger: 'schedule' });

    expect(await memberIds(category.id)).toEqual([inFilter.id]);
  });
});

describe('GameCategoryMembershipService: the rule catalog seam (real PG)', () => {
  const namePrefixRule = () =>
    defineGameCategoryRule({
      key: 'name_prefix',
      paramsSchema: z.object({ prefix: z.string().min(1) }).strict(),
      async resolve({ params, candidateIds }) {
        const rows = await db.drizzle.db.select({ id: game.id, name: game.name }).from(game);
        const allowed = candidateIds ? new Set(candidateIds) : null;
        return rows
          .filter((row) => row.name.startsWith(params.prefix))
          .filter((row) => allowed === null || allowed.has(row.id))
          .map((row) => row.id);
      },
    });

  it('runs an operator-supplied kind, alone and narrowing a built-in clause', async () => {
    const { rules } = makeServices([namePrefixRule()]);
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const megaListed = await seedGame(listed.id, { name: 'Mega Reels' });
    const megaOther = await seedGame(other.id, { name: 'Mega Wheel' });
    await seedGame(listed.id, { name: 'Tiny Reels' });
    const prefix = { key: 'name_prefix', params: { prefix: 'Mega' } };

    expect((await rules.resolveGameIds([prefix])).sort()).toEqual(
      [megaListed.id, megaOther.id].sort(),
    );
    expect(await rules.resolveGameIds([providers(listed.id), prefix])).toEqual([megaListed.id]);
  });

  it('two clauses of the same kind AND together', async () => {
    const { rules } = makeServices();
    const provider = await seedProvider();
    const [tagA, tagB] = [await seedTag(), await seedTag()];
    const both = await seedGame(provider.id, { tagIds: [tagA.id, tagB.id] });
    await seedGame(provider.id, { tagIds: [tagA.id] });

    expect(await rules.resolveGameIds([tags(tagA.id), tags(tagB.id)])).toEqual([both.id]);
  });

  it('drops what a careless definition returns outside its candidates', async () => {
    const { rules } = makeServices([
      defineGameCategoryRule({
        key: 'everything',
        paramsSchema: z.object({}).strict(),
        async resolve() {
          const rows = await db.drizzle.db.select({ id: game.id }).from(game);
          return rows.flatMap((row) => [row.id, row.id]);
        },
      }),
    ]);
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const inside = await seedGame(listed.id);
    await seedGame(other.id);

    expect(
      await rules.resolveGameIds([providers(listed.id), { key: 'everything', params: {} }]),
    ).toEqual([inside.id]);
  });

  it('drops a malformed id instead of failing the link writes', async () => {
    const provider = await seedProvider();
    const real = await seedGame(provider.id);
    const { rules } = makeServices([
      defineGameCategoryRule({
        key: 'sloppy',
        paramsSchema: z.object({}).strict(),
        resolve: async () => ['not-a-uuid', real.id],
      }),
    ]);

    expect(await rules.resolveGameIds([{ key: 'sloppy', params: {} }])).toEqual([real.id]);
  });

  it('matches an uppercase id to its game, keeping a member and adding a new one', async () => {
    const provider = await seedProvider();
    const [member, added] = [await seedGame(provider.id), await seedGame(provider.id)];
    const category = await seedRuleCategory([{ key: 'shouting', params: {} }]);
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: member.id, categoryId: category.id, source: 'rule' });
    const { membership, rules } = makeServices([
      defineGameCategoryRule({
        key: 'shouting',
        paramsSchema: z.object({}).strict(),
        resolve: async () => [member.id.toUpperCase(), added.id.toUpperCase(), member.id],
      }),
    ]);

    expect(await rules.resolveGameIds([{ key: 'shouting', params: {} }])).toEqual([
      member.id,
      added.id,
    ]);
    await expect(
      membership.evaluate({ categoryId: category.id, trigger: 'event' }),
    ).resolves.toMatchObject({ matchedCount: 2, addedCount: 1, removedCount: 0 });
    expect(await memberIds(category.id)).toEqual([member.id, added.id].sort());
  });

  it('refuses a result that is not a list, keeping the games', async () => {
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const category = await seedRuleCategory([{ key: 'broken', params: {} }]);
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: member.id, categoryId: category.id, source: 'rule' });
    const { membership } = makeServices([
      defineGameCategoryRule({
        key: 'broken',
        paramsSchema: z.object({}).strict(),
        resolve: (async () => undefined) as unknown as () => Promise<string[]>,
      }),
    ]);

    await expect(
      membership.evaluate({ categoryId: category.id, trigger: 'event' }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
    expect(await memberIds(category.id)).toEqual([member.id]);
  });

  it('rejects an unknown key and params its definition refuses when a rule is saved', async () => {
    const { categories } = makeServices();
    const base = { name: 'Category', membershipMode: 'rule' as const, ...ACTOR };

    await expect(
      categories.createCategory({
        ...base,
        slug: `category-${randomUUID()}`,
        membershipRule: [{ key: 'no_such_kind', params: {} }],
      }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
    await expect(
      categories.createCategory({
        ...base,
        slug: `category-${randomUUID()}`,
        membershipRule: [{ key: 'most_played', params: { periodDays: 7, limit: 0 } }],
      }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
  });

  it('a kind that is no longer bound is skipped, one that throws is retried, and both keep the games', async () => {
    const withKind = makeServices([namePrefixRule()]);
    const provider = await seedProvider();
    const member = await seedGame(provider.id, { name: 'Mega Reels' });
    const category = await withKind.categories.createCategory({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      membershipMode: 'rule',
      membershipRule: [{ key: 'name_prefix', params: { prefix: 'Mega' } }],
      ...ACTOR,
    });
    expect(await memberIds(category.id)).toEqual([member.id]);

    const withoutKind = makeServices();
    await expect(
      withoutKind.membership.evaluateJob({ categoryId: category.id, trigger: 'schedule' }),
    ).resolves.toBeUndefined();
    expect(withoutKind.events.emit).not.toHaveBeenCalled();
    await expect(
      withoutKind.membership.evaluate({ categoryId: category.id, trigger: 'admin', actor: ACTOR }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
    expect(withoutKind.events.emit).toHaveBeenCalledTimes(1);
    expect(withoutKind.events.emit).toHaveBeenCalledWith(
      'gaming.category.membership_evaluation.failed',
      {
        categoryId: category.id,
        actorId: ACTOR.actorId,
        reason: 'Unknown rule key: name_prefix',
        ip: null,
        userAgent: null,
      },
    );

    const throwing = makeServices([
      defineGameCategoryRule({
        key: 'name_prefix',
        paramsSchema: z.object({ prefix: z.string() }).strict(),
        async resolve() {
          throw new Error('upstream down');
        },
      }),
    ]);
    await expect(
      throwing.membership.evaluateJob({ categoryId: category.id, trigger: 'schedule' }),
    ).rejects.toThrow(GameCategoryRuleUnavailableError);
    expect(await memberIds(category.id)).toEqual([member.id]);
    expect((await throwing.categories.getCategory(category.id)).membershipLastError).toBe(
      'name_prefix: the rule could not be resolved',
    );
  });

  it.each(['missing kind', 'invalid params'] as const)(
    'keeps membership when an empty first clause precedes a clause with %s',
    async (failure) => {
      const withKind = makeServices([namePrefixRule()]);
      const [listed, other] = [await seedProvider(), await seedProvider()];
      const member = await seedGame(listed.id, { name: 'Mega Reels' });
      const category = await withKind.categories.createCategory({
        slug: `category-${randomUUID()}`,
        name: 'Category',
        membershipMode: 'rule',
        membershipRule: [providers(listed.id), { key: 'name_prefix', params: { prefix: 'Mega' } }],
        ...ACTOR,
      });
      await db.drizzle.db.update(game).set({ providerId: other.id }).where(eq(game.id, member.id));
      const { membership, categories, events, jobQueue } = makeServices(
        failure === 'missing kind'
          ? []
          : [
              defineGameCategoryRule({
                ...namePrefixRule(),
                paramsSchema: z.object({ prefix: z.string().min(10) }).strict(),
              }),
            ],
      );

      await expect(
        membership.evaluate({ categoryId: category.id, trigger: 'admin', actor: ACTOR }),
      ).rejects.toThrow(GameCategoryRuleInvalidError);

      expect(await memberIds(category.id)).toEqual([member.id]);
      const after = await categories.getCategory(category.id);
      expect(after.membershipEvaluatedAt).toBe(category.membershipEvaluatedAt);
      expect(after.membershipAttemptedAt).not.toBeNull();
      expect(after.membershipLastError).toContain('name_prefix');
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        'gaming.category.membership_evaluation.failed',
        expect.objectContaining({ categoryId: category.id, reason: after.membershipLastError }),
      );
      expect(jobQueue.enqueue).not.toHaveBeenCalled();
    },
  );

  it('cannot save a rule whose validate throws, and refuses params that are not plain JSON', async () => {
    const { rules } = makeServices([
      defineGameCategoryRule({
        key: 'flaky_validate',
        paramsSchema: z.object({}).strict(),
        resolve: async () => [],
        async validate() {
          throw new Error('lookup service down');
        },
      }),
      defineGameCategoryRule({
        key: 'since',
        paramsSchema: z.object({ since: z.coerce.date() }).strict(),
        resolve: async () => [],
      }),
    ]);

    await expect(rules.normalizeRule([{ key: 'flaky_validate', params: {} }])).rejects.toThrow(
      GameCategoryRuleUnavailableError,
    );
    await expect(
      rules.normalizeRule([{ key: 'since', params: { since: '2026-01-01' } }]),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
  });

  it('a kind with no isAffectedBy - most_played included - is never event-triggered; the sweep still reaches it', async () => {
    const { jobQueue, triggers } = makeServices([namePrefixRule()]);
    const custom = await seedRuleCategory([{ key: 'name_prefix', params: { prefix: 'Mega' } }]);
    await seedRuleCategory([mostPlayed(5)]);

    expect(
      await triggers.affectedCategoryIds({
        providerIds: [randomUUID()],
        tagIds: [randomUUID()],
        playabilityChanged: true,
      }),
    ).toEqual([]);
    await triggers.sweep();
    expect(jobQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(jobQueue.enqueue).toHaveBeenCalledWith(
      GAME_CATEGORY_MEMBERSHIP_QUEUE,
      { categoryId: custom.id, trigger: 'schedule' },
      { attempts: 3, backoff: { type: 'exponential', delayMs: 5_000 } },
    );
  });

  it('lists every bound kind with its params JSON Schema and reporting flag', async () => {
    const { rules } = makeServices([namePrefixRule()]);

    const options = rules.listRuleOptions();

    expect(options.map((option) => [option.key, option.exposesReporting])).toEqual([
      ['providers', false],
      ['tags', false],
      ['most_played', false],
      ['name_prefix', false],
    ]);
    expect(options.at(-1)?.paramsJsonSchema).toMatchObject({
      type: 'object',
      properties: { prefix: { type: 'string' } },
    });
  });
});

describe('GameCategoryMembershipService.evaluate: diffing (real PG)', () => {
  it('inserts new matches, deletes stale ones and keeps a surviving row untouched', async () => {
    const { membership, events, jobQueue } = makeServices();
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const kept = await seedGame(listed.id);
    const leaving = await seedGame(listed.id);
    const category = await seedRuleCategory([providers(listed.id)]);
    await membership.evaluate({ categoryId: category.id, trigger: 'event' });
    await db.drizzle.db
      .update(gameCategoryGame)
      .set({ pinnedPosition: 0 })
      .where(eq(gameCategoryGame.gameId, kept.id));
    const [keptBefore] = await db.drizzle.db
      .select()
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.gameId, kept.id));

    await db.drizzle.db.update(game).set({ providerId: other.id }).where(eq(game.id, leaving.id));
    const arriving = await seedGame(listed.id);
    events.emit.mockClear();
    jobQueue.enqueue.mockClear();
    const result = await membership.evaluate({ categoryId: category.id, trigger: 'event' });

    expect(result).toMatchObject({ matchedCount: 2, addedCount: 1, removedCount: 1 });
    expect(await memberIds(category.id)).toEqual([kept.id, arriving.id].sort());
    const [keptAfter] = await db.drizzle.db
      .select()
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.gameId, kept.id));
    expect(keptAfter).toEqual(keptBefore);
    expect(events.emit).toHaveBeenCalledWith('gaming.category.membership_evaluated', {
      categoryId: category.id,
      actorId: SYSTEM_ACTOR_ID,
      trigger: 'event',
      matchedCount: 2,
      relabeledCount: 0,
      addedGameIds: [arriving.id],
      removedGameIds: [leaving.id],
      ip: null,
      userAgent: null,
    });
    expect(jobQueue.enqueue).toHaveBeenCalledWith(GAME_CATEGORY_RANK_QUEUE, {
      categoryId: category.id,
    });
  });

  it('a repeat run with nothing to change emits nothing and queues no rank', async () => {
    const { membership, events, jobQueue } = makeServices();
    const provider = await seedProvider();
    await seedGame(provider.id);
    const category = await seedRuleCategory([providers(provider.id)]);
    await membership.evaluate({ categoryId: category.id, trigger: 'event' });
    events.emit.mockClear();
    jobQueue.enqueue.mockClear();

    const result = await membership.evaluate({ categoryId: category.id, trigger: 'schedule' });

    expect(result).toMatchObject({ addedCount: 0, removedCount: 0 });
    expect(events.emit).not.toHaveBeenCalled();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it('an on-demand run is audited with the admin as actor even when nothing moved', async () => {
    const { membership, events } = makeServices();
    const provider = await seedProvider();
    const category = await seedRuleCategory([providers(provider.id)]);

    await membership.evaluate({ categoryId: category.id, trigger: 'admin', actor: ACTOR });

    expect(events.emit).toHaveBeenCalledWith(
      'gaming.category.membership_evaluated',
      expect.objectContaining({ actorId: ACTOR.actorId, trigger: 'admin', addedGameIds: [] }),
    );
  });

  it('refuses a manual category on demand and skips it as a job', async () => {
    const { membership } = makeServices();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const [manual] = await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `category-${randomUUID()}`, name: 'Manual' })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: member.id, categoryId: manual!.id });

    await expect(
      membership.evaluate({ categoryId: manual!.id, trigger: 'admin', actor: ACTOR }),
    ).rejects.toThrow(GameCategoryNotRuleManagedError);
    await expect(
      membership.evaluateJob({ categoryId: manual!.id, trigger: 'event' }),
    ).resolves.toBeUndefined();
    expect(await memberIds(manual!.id)).toEqual([member.id]);
  });
});

describe('GameCategoryService: membership mode switches (real PG)', () => {
  it('manual -> rule replaces the hand-picked games on the first evaluation', async () => {
    const { categories } = makeServices();
    const [listed, other] = [await seedProvider(), await seedProvider()];
    const matched = await seedGame(listed.id);
    const handPicked = await seedGame(other.id);
    const category = await categories.createCategory({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      ...ACTOR,
    });
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: handPicked.id, categoryId: category.id });

    const updated = await categories.updateCategory({
      id: category.id,
      membershipMode: 'rule',
      membershipRule: [providers(listed.id)],
      ...ACTOR,
    });

    expect(updated).toMatchObject({
      membershipMode: 'rule',
      membershipRule: [providers(listed.id)],
    });
    expect(updated.membershipEvaluatedAt).not.toBeNull();
    expect(await memberRows(category.id)).toEqual([{ gameId: matched.id, source: 'rule' }]);
  });

  it("rule -> manual clears a failed evaluation's attempt and error, keeping the rule", async () => {
    const { categories, membership } = makeServices();
    const provider = await seedProvider();
    await seedGame(provider.id);
    const category = await seedRuleCategory([providers(provider.id)]);
    await db.drizzle.db
      .update(gameCategory)
      .set({ membershipRule: [{ key: 'removed_kind', params: {} }] })
      .where(eq(gameCategory.id, category.id));
    await membership.evaluateJob({ categoryId: category.id, trigger: 'schedule' });

    const updated = await categories.updateCategory({
      id: category.id,
      membershipMode: 'manual',
      ...ACTOR,
    });

    expect(updated).toMatchObject({
      membershipMode: 'manual',
      membershipRule: [{ key: 'removed_kind', params: {} }],
      membershipAttemptedAt: null,
      membershipLastError: null,
    });
  });

  it('rule -> manual keeps the current games, the stored rule, and hands the rows to the admin', async () => {
    const { categories } = makeServices();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const created = await categories.createCategory({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
      ...ACTOR,
    });
    expect(await memberIds(created.id)).toEqual([member.id]);

    const updated = await categories.updateCategory({
      id: created.id,
      membershipMode: 'manual',
      ...ACTOR,
    });

    expect(updated).toMatchObject({
      membershipMode: 'manual',
      membershipRule: [providers(provider.id)],
    });
    expect(await memberRows(created.id)).toEqual([{ gameId: member.id, source: 'manual' }]);
  });

  it('changing the rule of a rule-mode category re-evaluates before returning', async () => {
    const { categories, events } = makeServices();
    const [first, second] = [await seedProvider(), await seedProvider()];
    await seedGame(first.id);
    const inSecond = await seedGame(second.id);
    const created = await categories.createCategory({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      membershipMode: 'rule',
      membershipRule: [providers(first.id)],
      ...ACTOR,
    });
    events.emit.mockClear();

    await categories.updateCategory({
      id: created.id,
      membershipRule: [providers(second.id)],
      ...ACTOR,
    });

    expect(await memberIds(created.id)).toEqual([inSecond.id]);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.category.updated',
      expect.objectContaining({
        before: expect.objectContaining({ membershipRule: [providers(first.id)] }),
        after: expect.objectContaining({ membershipRule: [providers(second.id)] }),
      }),
    );
  });

  it('re-sending the stored rule is not a change: no event, no evaluation', async () => {
    const { categories, events } = makeServices();
    const created = await categories.createCategory({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      membershipMode: 'rule',
      membershipRule: [mostPlayed(5)],
      ...ACTOR,
    });
    events.emit.mockClear();

    await categories.updateCategory({
      id: created.id,
      membershipRule: [{ key: 'most_played', params: { limit: 5, periodDays: 7 } }],
      ...ACTOR,
    });

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects rule mode without a rule, and a rule naming an unknown provider', async () => {
    const { categories } = makeServices();
    const base = { slug: `category-${randomUUID()}`, name: 'Category', ...ACTOR };

    await expect(categories.createCategory({ ...base, membershipMode: 'rule' })).rejects.toThrow(
      GameCategoryRuleRequiredError,
    );
    await expect(
      categories.createCategory({
        ...base,
        membershipMode: 'rule',
        membershipRule: [providers(randomUUID())],
      }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
  });
});

describe('GameCategoryMembershipService: re-evaluation triggers (real PG)', () => {
  it('enqueueAffected queues only the rule categories the change can reach', async () => {
    const { jobQueue, triggers } = makeServices();
    const [providerA, providerB] = [await seedProvider(), await seedProvider()];
    const byA = await seedRuleCategory([providers(providerA.id)]);
    await seedRuleCategory([providers(providerB.id)]);
    await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `category-${randomUUID()}`, name: 'Manual' });

    triggers.enqueueAffected({
      providerIds: [providerA.id],
      tagIds: [],
      playabilityChanged: false,
    });

    triggers.enqueueAffected({
      providerIds: [providerA.id],
      tagIds: [],
      playabilityChanged: true,
    });

    await vi.waitFor(() => {
      expect(jobQueue.enqueue.mock.calls).toEqual([
        [
          GAME_CATEGORY_MEMBERSHIP_QUEUE,
          { categoryId: byA.id, trigger: 'event' },
          expect.objectContaining({ attempts: 3 }),
        ],
      ]);
    });
  });

  it('records an over-cap result after saving and rejects it on explicit evaluation', async () => {
    const { membership, categories, rules } = makeServices();
    const provider = await seedProvider();
    await db.drizzle.db.execute(sql`
      INSERT INTO game (name, slug, provider_id, aggregator)
      SELECT 'Bulk', 'bulk-' || n, ${provider.id}::uuid, 'direct'
      FROM generate_series(1, ${GAME_CATEGORY_RULE_MATCH_MAX + 1}) AS n
    `);

    const saved = await categories.createCategory({
      slug: `category-${randomUUID()}`,
      name: 'Category',
      membershipMode: 'rule',
      membershipRule: [providers(provider.id)],
      ...ACTOR,
    });
    expect(saved.membershipEvaluatedAt).toBeNull();
    expect(saved.membershipAttemptedAt).not.toBeNull();
    expect(saved.membershipLastError).toMatch(/exceeding the 5000-game cap/);
    expect(await memberIds(saved.id)).toEqual([]);
    await expect(rules.resolveGameIds([providers(provider.id), mostPlayed(1)])).rejects.toThrow(
      GameCategoryRuleTooBroadError,
    );
    const grown = await seedRuleCategory([providers(provider.id)]);
    await expect(
      membership.evaluate({ categoryId: grown.id, trigger: 'schedule' }),
    ).rejects.toThrow(GameCategoryRuleTooBroadError);
    expect(await memberIds(grown.id)).toEqual([]);
    const [recorded] = await db.drizzle.db
      .select({
        evaluatedAt: gameCategory.membershipEvaluatedAt,
        attemptedAt: gameCategory.membershipAttemptedAt,
        lastError: gameCategory.membershipLastError,
      })
      .from(gameCategory)
      .where(eq(gameCategory.id, grown.id));
    expect(recorded?.evaluatedAt).toBeNull();
    expect(recorded?.attemptedAt).not.toBeNull();
    expect(recorded?.lastError).toMatch(/exceeding the 5000-game cap/);
  });

  it('a failed evaluation keeps the last success time; the next success clears the error', async () => {
    const { membership } = makeServices();
    const provider = await seedProvider();
    await seedGame(provider.id);
    const category = await seedRuleCategory([providers(provider.id)]);
    await membership.evaluate({ categoryId: category.id, trigger: 'schedule' });
    const read = async () => {
      const [row] = await db.drizzle.db
        .select({
          evaluatedAt: gameCategory.membershipEvaluatedAt,
          attemptedAt: gameCategory.membershipAttemptedAt,
          lastError: gameCategory.membershipLastError,
        })
        .from(gameCategory)
        .where(eq(gameCategory.id, category.id));
      return row!;
    };
    const healthy = await read();

    await db.drizzle.db
      .update(gameCategory)
      .set({ membershipRule: [{ key: 'removed_kind', params: {} }] })
      .where(eq(gameCategory.id, category.id));
    await membership.evaluateJob({ categoryId: category.id, trigger: 'schedule' });
    const broken = await read();
    expect(broken.evaluatedAt).toEqual(healthy.evaluatedAt);
    expect(broken.attemptedAt!.getTime()).toBeGreaterThan(healthy.attemptedAt!.getTime());
    expect(broken.lastError).toBe('Unknown rule key: removed_kind');

    await db.drizzle.db
      .update(gameCategory)
      .set({ membershipRule: [providers(provider.id)] })
      .where(eq(gameCategory.id, category.id));
    await membership.evaluate({ categoryId: category.id, trigger: 'schedule' });
    const recovered = await read();
    expect(recovered.lastError).toBeNull();
    expect(recovered.evaluatedAt!.getTime()).toBeGreaterThan(healthy.evaluatedAt!.getTime());
  });

  it('sweeps a never-resolving category last once it has been attempted', async () => {
    const { membership, jobQueue, triggers } = makeServices();
    const broken = await seedRuleCategory([{ key: 'removed_kind', params: {} }]);
    const healthy = await seedRuleCategory([providers((await seedProvider()).id)]);
    await membership.evaluateJob({ categoryId: broken.id, trigger: 'schedule' });

    await triggers.sweep();

    expect(jobQueue.enqueue.mock.calls.map(([, payload]) => payload.categoryId)).toEqual([
      healthy.id,
      broken.id,
    ]);
  });

  it('a stored rule that no longer parses is a rule that does not resolve, not a manual category', async () => {
    const { membership } = makeServices();
    const provider = await seedProvider();
    const member = await seedGame(provider.id);
    const category = await seedRuleCategory([providers(provider.id)]);
    await membership.evaluate({ categoryId: category.id, trigger: 'event' });
    await db.drizzle.db.execute(
      sql`UPDATE game_category SET membership_rule = '{"legacy":true}'::jsonb WHERE id = ${category.id}`,
    );

    await expect(
      membership.evaluate({ categoryId: category.id, trigger: 'admin', actor: ACTOR }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
    await expect(
      membership.evaluateJob({ categoryId: category.id, trigger: 'schedule' }),
    ).resolves.toBeUndefined();
    expect(await memberIds(category.id)).toEqual([member.id]);
  });

  it('a bare switch to rule mode re-checks the stored rule and keeps the games when it is dead', async () => {
    const { categories } = makeServices();
    const provider = await seedProvider();
    const handPicked = await seedGame(provider.id);
    const [category] = await db.drizzle.db
      .insert(gameCategory)
      .values({
        slug: `category-${randomUUID()}`,
        name: 'Category',
        membershipRule: [providers(randomUUID())],
      })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: handPicked.id, categoryId: category!.id });

    await expect(
      categories.updateCategory({ id: category!.id, membershipMode: 'rule', ...ACTOR }),
    ).rejects.toThrow(GameCategoryRuleInvalidError);
    expect(await memberIds(category!.id)).toEqual([handPicked.id]);
  });

  it('changeForGames names the providers and tags of the given games', async () => {
    const { triggers } = makeServices();
    const provider = await seedProvider();
    const tag = await seedTag();
    const created = await seedGame(provider.id, { tagIds: [tag.id] });

    expect(await triggers.changeForGames([created.id])).toEqual({
      providerIds: [provider.id],
      tagIds: [tag.id],
      playabilityChanged: true,
    });
  });

  it('sweep queues a scheduled run for every rule category and no manual one', async () => {
    const { jobQueue, triggers } = makeServices();
    const provider = await seedProvider();
    const first = await seedRuleCategory([providers(provider.id)]);
    const second = await seedRuleCategory([mostPlayed(3)]);
    await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `category-${randomUUID()}`, name: 'Manual' });

    await triggers.sweep();

    const queued = jobQueue.enqueue.mock.calls.map(([, payload]) => payload);
    expect(queued).toHaveLength(2);
    expect(queued).toEqual(
      expect.arrayContaining([
        { categoryId: first.id, trigger: 'schedule' },
        { categoryId: second.id, trigger: 'schedule' },
      ]),
    );
  });

  it('notifyGamesCreated announces only ids that are real game rows', async () => {
    const { events, triggers } = makeServices();
    const provider = await seedProvider();
    const created = await seedGame(provider.id);

    await triggers.notifyGamesCreated([created.id, randomUUID()]);

    expect(events.emit).toHaveBeenCalledWith('gaming.games.created', { gameIds: [created.id] });
  });
});
