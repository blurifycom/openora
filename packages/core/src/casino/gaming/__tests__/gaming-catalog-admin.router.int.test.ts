import { GameSortService } from '../service/game-sort.service.js';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type {
  GameAdapter,
  GameSortCatalog,
  PlayEligibilityPort,
  WalletCommands,
} from '@openora/core/contracts';
import {
  createGameCategoryRuleCatalog,
  createGameSortCatalog,
  defineGameCategoryRule,
  defineGameSort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeAdminGuard,
  makeIdentityReader,
  makeJobQueue,
  testContext,
} from '../../../testing/mock.js';
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
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import { createGamingRouter } from '../router/index.js';
import { GamingService } from '../service/gaming.service.js';
import { GameCategoryService } from '../service/game-category.service.js';
import { GameTagService } from '../service/game-tag.service.js';
import { GameProviderService } from '../service/game-provider.service.js';
import { GameCategoryMembershipService } from '../service/game-category-membership.service.js';
import { GameCategoryRuleService } from '../service/game-category-rule.service.js';
import { DrizzleAdminGameReporting } from '../admin-reporting.js';
import { createDefaultGameCategoryRules } from '../adapters/rules/index.js';
import { GameBulkService } from '../service/game-bulk.service.js';
import { UpdateGameInputSchema } from '../contract/index.js';

const CTX = testContext();
const URL_UNDER_CAP_RAW_OVER_CAP_ESCAPED = `https://cdn.example/${'"'.repeat(200)}`;

let db: TestDb;

const revenueRankRule = defineGameCategoryRule({
  key: 'test_revenue_rank',
  paramsSchema: z.object({}).strict(),
  exposesReporting: true,
  resolve: async () => [],
});

let shiftingCategoryId: string | null = null;
let shiftingCalls = 0;
const shiftStoredRule = async () => {
  shiftingCalls += 1;
  if (!shiftingCategoryId) {
    return;
  }
  await db.drizzle.db.execute(sql`
    UPDATE game_category
    SET membership_rule = jsonb_build_array(
      jsonb_build_object('key', 'test_shifting', 'params', jsonb_build_object('n', ${shiftingCalls}::int))
    ), membership_seq = membership_seq + 1
    WHERE id = ${shiftingCategoryId}
  `);
};
const shiftingRule = defineGameCategoryRule({
  key: 'test_shifting',
  paramsSchema: z.object({ n: z.number().int() }).strict(),
  async validate() {
    await shiftStoredRule();
    return null;
  },
  async resolve() {
    await shiftStoredRule();
    return [];
  },
});

let swappingCategoryId: string | null = null;
const swapToRevenueRank = async () => {
  if (!swappingCategoryId) {
    return;
  }
  await db.drizzle.db
    .update(gameCategory)
    .set({
      membershipRule: [{ key: 'test_revenue_rank', params: {} }],
      membershipSeq: sql`${gameCategory.membershipSeq} + 1`,
    })
    .where(eq(gameCategory.id, swappingCategoryId));
  swappingCategoryId = null;
};
const swappingRule = defineGameCategoryRule({
  key: 'test_swap_to_revenue',
  paramsSchema: z.object({}).strict(),
  async validate() {
    await swapToRevenueRank();
    return null;
  },
  async resolve() {
    await swapToRevenueRank();
    return [];
  },
});

const unavailableRule = defineGameCategoryRule({
  key: 'test_unavailable',
  paramsSchema: z.object({}).strict(),
  async resolve() {
    throw new Error('upstream down');
  },
});

function makeRuleCatalog() {
  return createGameCategoryRuleCatalog([
    ...createDefaultGameCategoryRules(db.drizzle, new DrizzleAdminGameReporting(db.drizzle)),
    revenueRankRule,
    shiftingRule,
    swappingRule,
    unavailableRule,
  ]);
}

const unrestricted: PlayEligibilityPort = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
});

function makeWalletCommands(): WalletCommands {
  return mock<WalletCommands>({
    debit: vi.fn().mockResolvedValue({ ok: true, newBalance: '0', currency: 'USD' }),
    credit: vi.fn(),
  });
}

function routerWith(
  adminGuard: AdminGuard,
  sortCatalog: GameSortCatalog = createGameSortCatalog(createDefaultGameSorts(db.drizzle)),
) {
  const events = makeEventBus();
  const jobQueue = makeJobQueue();
  const gaming = new GamingService(
    db.drizzle,
    events,
    mock<GameAdapter>({
      launchGame: vi.fn().mockResolvedValue({ launchUrl: 'https://mock/play', token: 'tok' }),
      endRound: vi.fn(),
    }),
    unrestricted,
    makeWalletCommands(),
    makeIdentityReader(),
  );
  const providers = new GameProviderService(db.drizzle, events);
  const rules = new GameCategoryRuleService(db.drizzle, makeRuleCatalog());
  const membership = new GameCategoryMembershipService(db.drizzle, events, jobQueue, rules);
  const categories = new GameCategoryService(
    db.drizzle,
    events,
    jobQueue,
    new GameSortService(sortCatalog),
    rules,
    membership,
  );
  const tags = new GameTagService(db.drizzle, events);
  const bulk = new GameBulkService(db.drizzle, events);
  return {
    router: createGamingRouter({
      gaming,
      providers,
      categories,
      rules,
      membership,
      tags,
      bulk,
      adminGuard,
      sorts: new GameSortService(sortCatalog),
    }),
    events,
    jobQueue,
  };
}

const denyingGuard = () => makeAdminGuard({ allow: [] });
const allowingGuard = () =>
  makeAdminGuard({ caller: { userId: '88888888-8888-4888-8888-888888888888' } });

type Router = ReturnType<typeof createGamingRouter>;

const GUARDED_ROUTES: ReadonlyArray<{ name: string; invoke: (r: Router) => Promise<unknown> }> = [
  { name: 'listAdminProviders', invoke: (r) => call(r.listAdminProviders, {}, { context: CTX }) },
  {
    name: 'getAdminProvider',
    invoke: (r) =>
      call(r.getAdminProvider, { id: '00000000-0000-4000-8000-000000000000' }, { context: CTX }),
  },
  {
    name: 'updateProvider',
    invoke: (r) =>
      call(
        r.updateProvider,
        { id: '00000000-0000-4000-8000-000000000000', name: 'X' },
        { context: CTX },
      ),
  },
  {
    name: 'createProvider',
    invoke: (r) => call(r.createProvider, { slug: 'studio', name: 'Studio' }, { context: CTX }),
  },
  { name: 'listAdminCategories', invoke: (r) => call(r.listAdminCategories, {}, { context: CTX }) },
  {
    name: 'getAdminCategory',
    invoke: (r) =>
      call(r.getAdminCategory, { id: '00000000-0000-4000-8000-000000000000' }, { context: CTX }),
  },
  {
    name: 'createCategory',
    invoke: (r) => call(r.createCategory, { slug: 'slots', name: 'Slots' }, { context: CTX }),
  },
  {
    name: 'updateCategory',
    invoke: (r) =>
      call(
        r.updateCategory,
        { id: '00000000-0000-4000-8000-000000000000', name: 'X' },
        { context: CTX },
      ),
  },
  { name: 'listAdminTags', invoke: (r) => call(r.listAdminTags, {}, { context: CTX }) },
  {
    name: 'getAdminTag',
    invoke: (r) =>
      call(r.getAdminTag, { id: '00000000-0000-4000-8000-000000000000' }, { context: CTX }),
  },
  {
    name: 'createTag',
    invoke: (r) => call(r.createTag, { name: 'Featured' }, { context: CTX }),
  },
  {
    name: 'updateTag',
    invoke: (r) =>
      call(
        r.updateTag,
        { id: '00000000-0000-4000-8000-000000000000', name: 'X' },
        { context: CTX },
      ),
  },
  {
    name: 'deleteTag',
    invoke: (r) =>
      call(r.deleteTag, { id: '00000000-0000-4000-8000-000000000000' }, { context: CTX }),
  },
  {
    name: 'updateGame',
    invoke: (r) =>
      call(
        r.updateGame,
        { id: '00000000-0000-4000-8000-000000000000', name: 'X' },
        { context: CTX },
      ),
  },
  {
    name: 'listAdminGames',
    invoke: (r) => call(r.listAdminGames, {}, { context: CTX }),
  },
  {
    name: 'getCatalogStats',
    invoke: (r) => call(r.getCatalogStats, undefined, { context: CTX }),
  },
  {
    name: 'setGamesActive',
    invoke: (r) =>
      call(
        r.setGamesActive,
        { gameIds: ['00000000-0000-4000-8000-000000000000'], isActive: true },
        { context: CTX },
      ),
  },
  {
    name: 'addGameTags',
    invoke: (r) =>
      call(
        r.addGameTags,
        {
          gameIds: ['00000000-0000-4000-8000-000000000000'],
          tagIds: ['00000000-0000-4000-8000-000000000001'],
        },
        { context: CTX },
      ),
  },
  {
    name: 'addGameCategories',
    invoke: (r) =>
      call(
        r.addGameCategories,
        {
          gameIds: ['00000000-0000-4000-8000-000000000000'],
          categoryIds: ['00000000-0000-4000-8000-000000000001'],
        },
        { context: CTX },
      ),
  },
];

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${gameCategoryGame}, ${gameTagGame}, ${game}, ${gameProvider}, ${gameCategory}, ${gameTag} RESTART IDENTITY CASCADE`,
  );
});

describe('gaming catalog router authz', () => {
  it.each(GUARDED_ROUTES)('rejects $name for a non-privileged caller', async ({ invoke }) => {
    await expect(invoke(routerWith(denyingGuard()).router)).rejects.toBeInstanceOf(ORPCError);
  });

  it('writes nothing when the guard rejects a create', async () => {
    await expect(
      call(
        routerWith(denyingGuard()).router.createCategory,
        { slug: 'slots', name: 'Slots' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await db.drizzle.db.select().from(gameCategory)).toHaveLength(0);
  });

  it('serves the public catalog lists without a grant', async () => {
    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'acme', name: 'Acme', isActive: true })
      .returning();
    const [category] = await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: 'slots', name: 'Slots', isActive: true })
      .returning();
    const [g] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Aces',
        slug: `aces-${randomUUID()}`,
        providerId: provider!.id,
        aggregator: 'direct',
        isActive: true,
      })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: g!.id, categoryId: category!.id });

    const { router } = routerWith(denyingGuard());
    await expect(call(router.listProviders, {}, { context: CTX })).resolves.toMatchObject({
      items: [{ slug: 'acme' }],
      total: 1,
      page: 1,
      limit: 100,
    });
    await expect(
      call(router.listCategories, { page: 1, limit: 10 }, { context: CTX }),
    ).resolves.toMatchObject({
      items: [{ slug: 'slots', translations: {} }],
      total: 1,
      page: 1,
      limit: 10,
    });
    await expect(
      call(router.getProviderBySlug, { slug: 'acme' }, { context: CTX }),
    ).resolves.toMatchObject({ slug: 'acme' });
    await expect(
      call(router.getCategoryBySlug, { slug: 'slots' }, { context: CTX }),
    ).resolves.toMatchObject({ slug: 'slots', translations: {} });
    await expect(
      call(router.getProviderBySlug, { slug: 'ghost' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call(router.getCategoryBySlug, { slug: 'ghost' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(call(router.getGame, { id: g!.id }, { context: CTX })).resolves.toMatchObject({
      name: 'Aces',
      isActive: true,
    });
    await db.drizzle.db.update(game).set({ isActive: false }).where(eq(game.id, g!.id));
    await expect(call(router.getGame, { id: g!.id }, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('returns zero catalog stats for an empty catalog', async () => {
    const empty = { total: 0, active: 0, inactive: 0 };
    await expect(
      call(routerWith(allowingGuard()).router.getCatalogStats, undefined, { context: CTX }),
    ).resolves.toEqual({
      providers: empty,
      categories: empty,
      games: { ...empty, unavailable: 0, playable: 0 },
    });
  });

  it('counts an active game under an inactive provider as active but not playable', async () => {
    const [activeProvider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'acme', name: 'Acme', isActive: true })
      .returning();
    const [inactiveProvider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'dormant', name: 'Dormant', isActive: false })
      .returning();
    await db.drizzle.db.insert(gameCategory).values([
      { slug: 'slots', name: 'Slots', isActive: true },
      { slug: 'live', name: 'Live', isActive: true },
      { slug: 'retired', name: 'Retired', isActive: false },
    ]);
    await db.drizzle.db.insert(game).values([
      {
        name: 'Aces',
        slug: 'aces',
        providerId: activeProvider!.id,
        aggregator: 'direct',
        isActive: true,
      },
      { name: 'Blaze', slug: 'blaze', providerId: activeProvider!.id, aggregator: 'direct' },
      {
        name: 'Dusk',
        slug: 'dusk',
        providerId: activeProvider!.id,
        aggregator: 'direct',
        isActive: true,
        isUnavailable: true,
      },
      {
        name: 'Comet',
        slug: 'comet',
        providerId: inactiveProvider!.id,
        aggregator: 'direct',
        isActive: true,
      },
    ]);

    await expect(
      call(routerWith(allowingGuard()).router.getCatalogStats, undefined, { context: CTX }),
    ).resolves.toEqual({
      providers: { total: 2, active: 1, inactive: 1 },
      categories: { total: 3, active: 2, inactive: 1 },
      games: { total: 4, active: 3, inactive: 1, unavailable: 1, playable: 1 },
    });
  });

  it('creates a category and patches a game through the guarded routes', async () => {
    const { router, events } = routerWith(allowingGuard());

    const created = await call(
      router.createCategory,
      {
        slug: 'table-games',
        name: 'Table Games',
        translations: { de: { name: 'Tischspiele' } },
      },
      { context: CTX },
    );
    expect(created).toMatchObject({
      slug: 'table-games',
      sortOrder: 0,
      translations: { de: { name: 'Tischspiele' } },
    });

    await expect(
      call(
        router.updateCategory,
        { id: created.id, translations: { fr: { name: 'Jeux de table' } } },
        { context: CTX },
      ),
    ).resolves.toMatchObject({ translations: { fr: { name: 'Jeux de table' } } });

    const provider = await call(
      router.createProvider,
      {
        slug: 'acme',
        name: 'Acme',
        aggregatorMappings: [{ aggregator: 'aggregation-a', vendorId: 'studio-1' }],
      },
      { context: CTX },
    );
    const [g] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Roulette',
        slug: `roulette-${randomUUID()}`,
        providerId: provider.id,
        aggregator: 'direct',
      })
      .returning();

    const updated = await call(
      router.updateGame,
      { id: g!.id, isActive: false, categoryIds: [created.id] },
      { context: CTX },
    );
    expect(updated).toMatchObject({
      isActive: false,
      categories: [{ slug: 'table-games' }],
    });
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.game.updated',
      expect.objectContaining({ gameId: g!.id }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.provider.created',
      expect.objectContaining({ providerId: provider.id }),
    );
  });

  it('ignores an admin-supplied isUnavailable on the game PATCH', async () => {
    const { router } = routerWith(allowingGuard());
    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'acme', name: 'Acme', isActive: true })
      .returning();
    const [down] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Down',
        slug: 'down',
        providerId: provider!.id,
        aggregator: 'direct',
        isActive: true,
        isUnavailable: true,
      })
      .returning();

    const hostileInput = { id: down!.id, isActive: true, isUnavailable: false };
    const updated = await call(router.updateGame, hostileInput, { context: CTX });

    expect(updated).toMatchObject({ isActive: true, isUnavailable: true });
    await expect(call(router.getGame, { id: down!.id }, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('rejects a non-https customThumbnailUrl, a javascript: URL, a non-URL string, embedded credentials, and a URL that exceeds 512 characters once normalized', () => {
    const gameId = '00000000-0000-4000-8000-000000000000';
    for (const customThumbnailUrl of [
      'http://cdn.example/thumb.png',
      'javascript:alert(1)',
      'not-a-url',
      `https://cdn.example/${'a'.repeat(500)}`,
      'https://user:pass@cdn.example/thumb.png',
      URL_UNDER_CAP_RAW_OVER_CAP_ESCAPED,
    ]) {
      expect(UpdateGameInputSchema.safeParse({ id: gameId, customThumbnailUrl }).success).toBe(
        false,
      );
    }
  });

  it('accepts an https customThumbnailUrl exactly 512 characters long', () => {
    const gameId = '00000000-0000-4000-8000-000000000000';
    const prefix = 'https://cdn.example/';
    const exact = prefix + 'a'.repeat(512 - prefix.length);
    expect(exact.length).toBe(512);

    expect(UpdateGameInputSchema.safeParse({ id: gameId, customThumbnailUrl: exact }).success).toBe(
      true,
    );
  });

  it('stores customThumbnailUrl normalized: control characters are dropped and unsafe characters are percent-escaped', () => {
    const gameId = '00000000-0000-4000-8000-000000000000';

    expect(
      UpdateGameInputSchema.safeParse({
        id: gameId,
        customThumbnailUrl: 'https://cdn.example/x\u0000',
      }),
    ).toMatchObject({ success: true, data: { customThumbnailUrl: 'https://cdn.example/x' } });

    expect(
      UpdateGameInputSchema.safeParse({
        id: gameId,
        customThumbnailUrl: 'ht\ttps://cdn.example/x',
      }),
    ).toMatchObject({ success: true, data: { customThumbnailUrl: 'https://cdn.example/x' } });

    expect(
      UpdateGameInputSchema.safeParse({
        id: gameId,
        customThumbnailUrl: 'https://cdn.example/x"><script>alert(1)</script>',
      }),
    ).toMatchObject({
      success: true,
      data: {
        customThumbnailUrl: 'https://cdn.example/x%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
      },
    });
  });

  it('answers 400 to the geo filters when the compliance module is not loaded', async () => {
    const { router } = routerWith(allowingGuard());

    await expect(
      call(router.listAdminGames, { geoBlocked: true }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    await expect(
      call(router.listAdminGames, { geoBlockedCountries: ['DE'] }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    await expect(call(router.listAdminGames, {}, { context: CTX })).resolves.toMatchObject({
      total: 0,
    });
  });

  it('requires compliance:view for the geo filters only', async () => {
    const { router } = routerWith(makeAdminGuard({ allow: ['game-config:view'] }));

    await expect(
      call(router.listAdminGames, { geoBlocked: true }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(router.listAdminGames, { geoBlockedCountries: ['DE'] }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(router.listAdminGames, { tagIds: [randomUUID()] }, { context: CTX }),
    ).resolves.toMatchObject({ total: 0 });
  });

  it('creates, reads, updates, and deletes custom tags through guarded routes', async () => {
    const { router, events } = routerWith(allowingGuard());

    const created = await call(router.createTag, { name: 'Featured' }, { context: CTX });
    expect(created).toMatchObject({
      name: 'Featured',
      type: 'custom',
      visibility: 'invisible',
      metadata: null,
    });

    await expect(call(router.listAdminTags, {}, { context: CTX })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: created.id })],
    });
    await expect(
      call(router.getAdminTag, { id: created.id }, { context: CTX }),
    ).resolves.toMatchObject({ id: created.id, name: 'Featured' });
    await expect(
      call(
        router.updateTag,
        {
          id: created.id,
          visibility: 'visible',
          metadata: { theme: 'promo' },
        },
        { context: CTX },
      ),
    ).resolves.toMatchObject({ visibility: 'visible' });
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.tag.updated',
      expect.objectContaining({ tagId: created.id }),
    );
    await expect(call(router.deleteTag, { id: created.id }, { context: CTX })).resolves.toBe(true);
  });

  it('strips an admin-supplied type and always creates a custom tag', async () => {
    const { router } = routerWith(allowingGuard());

    const created = await call(
      router.createTag,
      { name: 'Sneaky', type: 'system' } as unknown as { name: string },
      { context: CTX },
    );

    expect(created).toMatchObject({ name: 'Sneaky', type: 'custom' });
  });

  it('refuses deleting a system tag through the guarded route', async () => {
    const { router } = routerWith(allowingGuard());
    const [system] = await db.drizzle.db
      .insert(gameTag)
      .values({ name: 'System', type: 'system' })
      .returning();
    if (!system) {
      throw new Error('failed to seed a system tag');
    }

    await expect(
      call(router.deleteTag, { id: system.id }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      call(router.getAdminTag, { id: system.id }, { context: CTX }),
    ).resolves.toMatchObject({
      id: system.id,
    });
  });

  it('previews a built-in rule with game-config:view alone, but a reporting kind needs report:view too', async () => {
    const configOnly = routerWith(makeAdminGuard({ allow: ['game-config:view'] })).router;
    const mostPlayed = [{ key: 'most_played', params: { periodDays: 7, limit: 5 } }];
    const revenueRank = [{ key: 'test_revenue_rank', params: {} }];

    await expect(
      call(configOnly.previewCategoryRule, { rule: mostPlayed }, { context: CTX }),
    ).resolves.toMatchObject({ total: 0 });
    await expect(
      call(configOnly.previewCategoryRule, { rule: revenueRank }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const withReports = routerWith(
      makeAdminGuard({ allow: ['game-config:view', 'report:view'] }),
    ).router;
    await expect(
      call(withReports.previewCategoryRule, { rule: revenueRank }, { context: CTX }),
    ).resolves.toMatchObject({ total: 0 });
  });

  it('answers 503, not 400, when a rule cannot be resolved right now, keeping the games', async () => {
    const { router } = routerWith(allowingGuard());
    const unavailable = [{ key: 'test_unavailable', params: {} }];
    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `down-${randomUUID()}`, name: 'Down', isActive: true })
      .returning();
    const [member] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Kept',
        slug: `kept-${randomUUID()}`,
        providerId: provider!.id,
        aggregator: 'direct',
        isActive: true,
      })
      .returning();
    const [category] = await db.drizzle.db
      .insert(gameCategory)
      .values({
        slug: `down-${randomUUID()}`,
        name: 'Down',
        membershipMode: 'rule',
        membershipRule: unavailable,
      })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: member!.id, categoryId: category!.id, source: 'rule' });

    await expect(
      call(router.previewCategoryRule, { rule: unavailable }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
    await expect(
      call(router.evaluateCategoryMembership, { id: category!.id }, { context: CTX }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'test_unavailable: the rule could not be resolved',
    });
    const links = await db.drizzle.db
      .select({ gameId: gameCategoryGame.gameId })
      .from(gameCategoryGame)
      .where(eq(gameCategoryGame.categoryId, category!.id));
    expect(links).toEqual([{ gameId: member!.id }]);
  });

  it('needs report:view to send, switch to or evaluate a reporting-kind rule', async () => {
    const writeOnly = routerWith(
      makeAdminGuard({ allow: ['game-config:create', 'game-config:update'] }),
    ).router;
    const revenueRank = [{ key: 'test_revenue_rank', params: {} }];
    const [stored] = await db.drizzle.db
      .insert(gameCategory)
      .values({
        slug: `revenue-${randomUUID()}`,
        name: 'Revenue',
        membershipMode: 'rule',
        membershipRule: revenueRank,
      })
      .returning();
    const [manual] = await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `manual-${randomUUID()}`, name: 'Manual' })
      .returning();
    const [dormant] = await db.drizzle.db
      .insert(gameCategory)
      .values({
        slug: `dormant-${randomUUID()}`,
        name: 'Dormant',
        membershipMode: 'manual',
        membershipRule: revenueRank,
      })
      .returning();

    await expect(
      call(
        writeOnly.createCategory,
        {
          slug: `revenue-${randomUUID()}`,
          name: 'Revenue',
          membershipMode: 'rule',
          membershipRule: revenueRank,
        },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(
        writeOnly.updateCategory,
        { id: manual!.id, membershipMode: 'rule', membershipRule: revenueRank },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(
        writeOnly.createCategory,
        { slug: `revenue-${randomUUID()}`, name: 'Revenue', membershipRule: revenueRank },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(
        writeOnly.updateCategory,
        { id: manual!.id, membershipRule: revenueRank },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(writeOnly.updateCategory, { id: dormant!.id, membershipMode: 'rule' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [stillManual] = await db.drizzle.db
      .select({ membershipMode: gameCategory.membershipMode })
      .from(gameCategory)
      .where(eq(gameCategory.id, dormant!.id));
    expect(stillManual).toEqual({ membershipMode: 'manual' });
    await expect(
      call(writeOnly.evaluateCategoryMembership, { id: stored!.id }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      call(writeOnly.updateCategory, { id: stored!.id, name: 'Renamed' }, { context: CTX }),
    ).resolves.toMatchObject({ name: 'Renamed' });

    const withReports = routerWith(
      makeAdminGuard({ allow: ['game-config:update', 'report:view'] }),
    ).router;
    await expect(
      call(withReports.evaluateCategoryMembership, { id: stored!.id }, { context: CTX }),
    ).resolves.toBeDefined();
  });

  describe('when a reporting rule replaces the one a caller was authorized for', () => {
    const revenueRank = [{ key: 'test_revenue_rank', params: {} }];
    const writeOnly = () => routerWith(makeAdminGuard({ allow: ['game-config:update'] })).router;

    async function seedSwappingCategory(mode: 'manual' | 'rule') {
      const [provider] = await db.drizzle.db
        .insert(gameProvider)
        .values({ slug: `swapping-${randomUUID()}`, name: 'Swapping', isActive: true })
        .returning();
      const [member] = await db.drizzle.db
        .insert(game)
        .values({
          name: 'Swapping Game',
          slug: `swapping-game-${randomUUID()}`,
          providerId: provider!.id,
          aggregator: 'direct',
          isActive: true,
        })
        .returning();
      const [category] = await db.drizzle.db
        .insert(gameCategory)
        .values({
          slug: `swapping-${randomUUID()}`,
          name: 'Swapping',
          membershipMode: mode,
          membershipRule: [{ key: 'test_swap_to_revenue', params: {} }],
        })
        .returning();
      await db.drizzle.db
        .insert(gameCategoryGame)
        .values({ gameId: member!.id, categoryId: category!.id });
      swappingCategoryId = category!.id;
      return { category: category!, member: member! };
    }

    async function readState(categoryId: string) {
      const [row] = await db.drizzle.db
        .select({
          mode: gameCategory.membershipMode,
          rule: gameCategory.membershipRule,
          lastError: gameCategory.membershipLastError,
        })
        .from(gameCategory)
        .where(eq(gameCategory.id, categoryId));
      const links = await db.drizzle.db
        .select({ gameId: gameCategoryGame.gameId })
        .from(gameCategoryGame)
        .where(eq(gameCategoryGame.categoryId, categoryId));
      return { ...row, memberIds: links.map((link) => link.gameId) };
    }

    afterEach(() => {
      swappingCategoryId = null;
    });

    it('a bare switch to rule mode is refused on the rule it would apply', async () => {
      const { category, member } = await seedSwappingCategory('manual');

      await expect(
        call(
          writeOnly().updateCategory,
          { id: category.id, membershipMode: 'rule' },
          { context: CTX },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await readState(category.id)).toEqual({
        mode: 'manual',
        rule: revenueRank,
        lastError: null,
        memberIds: [member.id],
      });
    });

    it('an on-demand evaluation is refused on the rule it claims, writing nothing', async () => {
      const { category, member } = await seedSwappingCategory('rule');
      const { router, events } = routerWith(makeAdminGuard({ allow: ['game-config:update'] }));

      await expect(
        call(router.evaluateCategoryMembership, { id: category.id }, { context: CTX }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await readState(category.id)).toEqual({
        mode: 'rule',
        rule: revenueRank,
        lastError: null,
        memberIds: [member.id],
      });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('when the rule keeps changing underneath a write', () => {
    async function seedShiftingCategory(mode: 'manual' | 'rule') {
      const [provider] = await db.drizzle.db
        .insert(gameProvider)
        .values({ slug: `shifting-${randomUUID()}`, name: 'Shifting', isActive: true })
        .returning();
      const [member] = await db.drizzle.db
        .insert(game)
        .values({
          name: 'Shifting Game',
          slug: `shifting-game-${randomUUID()}`,
          providerId: provider!.id,
          aggregator: 'direct',
          isActive: true,
        })
        .returning();
      const [category] = await db.drizzle.db
        .insert(gameCategory)
        .values({
          slug: `shifting-${randomUUID()}`,
          name: 'Shifting',
          membershipMode: mode,
          membershipRule: [{ key: 'test_shifting', params: { n: 0 } }],
        })
        .returning();
      await db.drizzle.db
        .insert(gameCategoryGame)
        .values({ gameId: member!.id, categoryId: category!.id });
      shiftingCategoryId = category!.id;
      shiftingCalls = 0;
      return { category: category!, member: member! };
    }

    afterEach(() => {
      shiftingCategoryId = null;
    });

    it('a bare switch to rule mode gives up with 409 after three stale attempts', async () => {
      const { router } = routerWith(allowingGuard());
      const { category, member } = await seedShiftingCategory('manual');

      await expect(
        call(router.updateCategory, { id: category.id, membershipMode: 'rule' }, { context: CTX }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(shiftingCalls).toBe(3);
      const [row] = await db.drizzle.db
        .select({ mode: gameCategory.membershipMode })
        .from(gameCategory)
        .where(eq(gameCategory.id, category.id));
      expect(row?.mode).toBe('manual');
      const links = await db.drizzle.db
        .select({ gameId: gameCategoryGame.gameId })
        .from(gameCategoryGame)
        .where(eq(gameCategoryGame.categoryId, category.id));
      expect(links).toEqual([{ gameId: member.id }]);
    });

    it('an on-demand evaluation gives up with 409 without stamping a newer configuration', async () => {
      const { router } = routerWith(allowingGuard());
      const { category, member } = await seedShiftingCategory('rule');

      await expect(
        call(router.evaluateCategoryMembership, { id: category.id }, { context: CTX }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      expect(shiftingCalls).toBe(3);
      const [status] = await db.drizzle.db
        .select({
          evaluatedAt: gameCategory.membershipEvaluatedAt,
          attemptedAt: gameCategory.membershipAttemptedAt,
          lastError: gameCategory.membershipLastError,
        })
        .from(gameCategory)
        .where(eq(gameCategory.id, category.id));
      expect(status?.evaluatedAt).toBeNull();
      expect(status?.attemptedAt).toBeNull();
      expect(status?.lastError).toBeNull();
      const links = await db.drizzle.db
        .select({ gameId: gameCategoryGame.gameId })
        .from(gameCategoryGame)
        .where(eq(gameCategoryGame.categoryId, category.id));
      expect(links).toEqual([{ gameId: member.id }]);
    });
  });
});

describe('gaming category sort-config route', () => {
  const weightedSort = defineGameSort({
    key: 'weighted',
    directions: ['desc', 'asc'],
    paramsSchema: z.object({
      window: z.string(),
      min: z.number(),
      filter: z.object({ volatility: z.string(), rtp: z.number() }),
    }),
    async rank({ gameIds }) {
      return gameIds;
    },
  });
  const weightedParams = { window: '7d', min: 96, filter: { volatility: 'high', rtp: 97 } };

  const readCategory = async (id: string) => {
    const [row] = await db.drizzle.db
      .select({
        rankDirtyAt: gameCategory.rankDirtyAt,
        storedParams: sql<string>`${gameCategory.sortParams}::text`,
      })
      .from(gameCategory)
      .where(eq(gameCategory.id, id));
    return row!;
  };

  it('treats a resubmitted sort config as unchanged despite jsonb reordering its keys', async () => {
    const [category] = await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `weighted-${randomUUID()}`, name: 'Weighted' })
      .returning();
    const catalog = createGameSortCatalog([...createDefaultGameSorts(db.drizzle), weightedSort]);
    const first = routerWith(allowingGuard(), catalog);
    await call(
      first.router.updateCategory,
      { id: category!.id, sortKey: 'weighted', sortParams: weightedParams },
      { context: CTX },
    );
    await db.drizzle.db
      .update(gameCategory)
      .set({ rankDirtyAt: null })
      .where(eq(gameCategory.id, category!.id));
    expect((await readCategory(category!.id)).storedParams).toBe(
      '{"min": 96, "filter": {"rtp": 97, "volatility": "high"}, "window": "7d"}',
    );

    const { router, events, jobQueue } = routerWith(allowingGuard(), catalog);
    await expect(
      call(
        router.updateCategory,
        { id: category!.id, sortKey: 'weighted', sortParams: weightedParams },
        { context: CTX },
      ),
    ).resolves.toMatchObject({ sortKey: 'weighted', sortParams: weightedParams });

    expect(events.emit).not.toHaveBeenCalled();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
    expect((await readCategory(category!.id)).rankDirtyAt).toBeNull();
  });
});
