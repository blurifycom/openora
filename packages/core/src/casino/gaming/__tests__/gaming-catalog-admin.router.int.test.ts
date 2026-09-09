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
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
  gameRound,
  gameTag,
  gameTagGame,
} from '../schema/index.js';
import { createGamingRouter } from '../router/index.js';
import { GamingService } from '../service/gaming.service.js';
import { GameCategoryService } from '../service/game-category.service.js';
import { GameTagService } from '../service/game-tag.service.js';
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
  const tags = new GameTagService(db.drizzle, events);
  return {
    router: createGamingRouter({ gaming, providers, categories, tags, adminGuard }),
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
    await expect(call(router.listProviders, {}, { context: CTX })).resolves.toMatchObject([
      { slug: 'acme' },
    ]);
    await expect(call(router.listCategories, {}, { context: CTX })).resolves.toMatchObject([
      { slug: 'slots' },
    ]);
    await expect(call(router.getGame, { id: g!.id }, { context: CTX })).resolves.toMatchObject({
      name: 'Aces',
      isActive: true,
    });
    await db.drizzle.db.update(game).set({ isActive: false }).where(eq(game.id, g!.id));
    await expect(call(router.getGame, { id: g!.id }, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('creates a category and patches a game through the guarded routes', async () => {
    const { router, events } = routerWith(allowingGuard());

    const created = await call(
      router.createCategory,
      { slug: 'table-games', name: 'Table Games' },
      { context: CTX },
    );
    expect(created).toMatchObject({ slug: 'table-games', sortOrder: 0 });

    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'acme', name: 'Acme' })
      .returning();
    const [g] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Roulette',
        slug: `roulette-${randomUUID()}`,
        providerId: provider!.id,
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
  });

  it('creates, reads, updates, and deletes custom tags through guarded routes', async () => {
    const { router, events } = routerWith(allowingGuard());

    const created = await call(router.createTag, { name: 'Featured' }, { context: CTX });
    expect(created).toMatchObject({
      name: 'Featured',
      type: 'custom',
      visibility: 'invisible',
      badgeSettings: { badgeColor: '#3377ff', textColor: '#ffffff' },
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
          badgeSettings: { badgeColor: '#112233', textColor: '#ffffff' },
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
});
