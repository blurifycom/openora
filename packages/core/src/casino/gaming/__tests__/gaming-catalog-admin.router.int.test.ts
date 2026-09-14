import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { GameAdapter, PlayEligibilityPort, WalletCommands } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeEventBus,
  makeAdminGuard,
  makeIdentityReader,
  testContext,
} from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider, gameRound } from '../schema/index.js';
import { createGamingRouter } from '../router/index.js';
import { GamingService } from '../service/gaming.service.js';
import { GameCategoryService } from '../service/game-category.service.js';
import { GameProviderService } from '../service/game-provider.service.js';

const CTX = testContext();

let db: TestDb;

const unrestricted: PlayEligibilityPort = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
});

function makeWalletCommands(): WalletCommands {
  return mock<WalletCommands>({
    debit: vi.fn().mockResolvedValue({ ok: true, newBalance: '0', currency: 'USD' }),
    credit: vi.fn(),
  });
}

function routerWith(adminGuard: AdminGuard) {
  const events = makeEventBus();
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
  const categories = new GameCategoryService(db.drizzle, events);
  return {
    router: createGamingRouter({ gaming, providers, categories, adminGuard }),
    events,
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
];

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameRound}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
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
    ).resolves.toEqual({ providers: empty, categories: empty, games: { ...empty, playable: 0 } });
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
      games: { total: 3, active: 2, inactive: 1, playable: 1 },
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
});
