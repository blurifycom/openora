import { GameSortService } from '../service/game-sort.service.js';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { GameAdapter, PlayEligibilityPort, WalletCommands } from '@openora/core/contracts';
import { createGameSortCatalog } from '@openora/core/contracts';
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
import { GameBulkService } from '../service/game-bulk.service.js';

const CTX = testContext();

let db: TestDb;

const unrestricted: PlayEligibilityPort = mock<PlayEligibilityPort>({
  isRestricted: vi.fn().mockResolvedValue(false),
});

function makeWalletCommands(): WalletCommands {
  return mock<WalletCommands>({ debit: vi.fn(), credit: vi.fn() });
}

function routerWith(adminGuard: AdminGuard) {
  const events = makeEventBus();
  const gaming = new GamingService(
    db.drizzle,
    events,
    mock<GameAdapter>({ launchGame: vi.fn(), endRound: vi.fn() }),
    unrestricted,
    makeWalletCommands(),
    makeIdentityReader(),
  );
  const providers = new GameProviderService(db.drizzle, events);
  const sortCatalog = createGameSortCatalog(createDefaultGameSorts(db.drizzle));
  const categories = new GameCategoryService(
    db.drizzle,
    events,
    makeJobQueue(),
    new GameSortService(sortCatalog),
  );
  const tags = new GameTagService(db.drizzle, events);
  const bulk = new GameBulkService(db.drizzle, events);
  return {
    router: createGamingRouter({
      gaming,
      providers,
      categories,
      tags,
      bulk,
      adminGuard,
      sorts: new GameSortService(sortCatalog),
    }),
    events,
  };
}

const denyingGuard = () => makeAdminGuard({ allow: [] });
const allowingGuard = () =>
  makeAdminGuard({ caller: { userId: '88888888-8888-4888-8888-888888888888' } });

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive: true, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game provider');
  }
  return row;
}

async function seedGame(providerId: string, overrides: Partial<typeof game.$inferInsert> = {}) {
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
  if (!row) {
    throw new Error('failed to seed a game');
  }
  return row;
}

async function seedManyGames(providerId: string, count: number) {
  const rows = await db.drizzle.db
    .insert(game)
    .values(
      Array.from({ length: count }, () => ({
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId,
        aggregator: 'direct',
        isActive: true,
      })),
    )
    .returning({ id: game.id });
  return rows.map((row) => row.id);
}

async function seedManyTags(count: number) {
  const rows = await db.drizzle.db
    .insert(gameTag)
    .values(Array.from({ length: count }, () => ({ name: `Tag ${randomUUID()}` })))
    .returning({ id: gameTag.id });
  return rows.map((row) => row.id);
}

async function seedTag(overrides: Partial<typeof gameTag.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameTag)
    .values({ name: `Tag ${randomUUID()}`, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game tag');
  }
  return row;
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: `Category ${randomUUID()}`, ...overrides })
    .returning();
  if (!row) {
    throw new Error('failed to seed a game category');
  }
  return row;
}

async function gameTagIdsFor(gameId: string) {
  const rows = await db.drizzle.db
    .select({ tagId: gameTagGame.tagId })
    .from(gameTagGame)
    .where(eq(gameTagGame.gameId, gameId))
    .orderBy(asc(gameTagGame.tagId));
  return rows.map((r) => r.tagId);
}

async function gameCategoryIdsFor(gameId: string) {
  const rows = await db.drizzle.db
    .select({ categoryId: gameCategoryGame.categoryId })
    .from(gameCategoryGame)
    .where(eq(gameCategoryGame.gameId, gameId))
    .orderBy(asc(gameCategoryGame.categoryId));
  return rows.map((r) => r.categoryId);
}

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

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('setGamesActive', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    await expect(
      call(
        routerWith(denyingGuard()).router.setGamesActive,
        { gameIds: [target.id], isActive: false },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    const [row] = await db.drizzle.db.select().from(game).where(eq(game.id, target.id));
    expect(row?.isActive).toBe(true);
  });

  it('rejects an unauthenticated caller the same way', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const { router } = routerWith(makeAdminGuard({ allow: [] }));
    await expect(
      call(router.setGamesActive, { gameIds: [target.id], isActive: false }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('deactivates by gameIds, by providerIds, and counts a mixed overlap once', async () => {
    const providerA = await seedProvider();
    const providerB = await seedProvider();
    const gA1 = await seedGame(providerA.id);
    const gA2 = await seedGame(providerA.id);
    const gB1 = await seedGame(providerB.id);
    const untouched = await seedGame(providerB.id);

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [gA1.id, gB1.id], providerIds: [providerA.id], isActive: false },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 3, unchangedCount: 0 },
      providers: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
      unplayableGameIds: [],
    });

    const rows = await db.drizzle.db
      .select({ id: game.id, isActive: game.isActive })
      .from(game)
      .where(inArray(game.id, [gA1.id, gA2.id, gB1.id, untouched.id]));
    const byId = new Map(rows.map((r) => [r.id, r.isActive]));
    expect(byId.get(gA1.id)).toBe(false);
    expect(byId.get(gA2.id)).toBe(false);
    expect(byId.get(gB1.id)).toBe(false);
    expect(byId.get(untouched.id)).toBe(true);

    const [providerRow] = await db.drizzle.db
      .select()
      .from(gameProvider)
      .where(eq(gameProvider.id, providerA.id));
    expect(providerRow?.isActive).toBe(false);

    expect(events.emit).toHaveBeenCalledTimes(2);
    const [summaryCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.games.bulk_updated',
    );
    const [providerCall] = events.emit.mock.calls.filter(
      ([topic]) => topic === 'gaming.provider.updated',
    );
    expect(summaryCall?.[1]).toMatchObject({
      operation: 'set_active',
      isActive: false,
      changedGameIds: [gA1.id, gA2.id, gB1.id].sort(),
      changedProviderIds: [providerA.id],
      notFound: { gameIds: [], providerIds: [] },
      bulkOperationId: expect.any(String),
    });
    expect(providerCall?.[1]).toMatchObject({
      providerId: providerA.id,
      before: expect.objectContaining({ isActive: true }),
      after: expect.objectContaining({ isActive: false }),
      bulkOperationId: summaryCall?.[1].bulkOperationId,
    });
  });

  it('reports nonexistent ids in notFound while the rest still applies', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const ghostGame = randomUUID();
    const ghostProvider = randomUUID();

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [target.id, ghostGame], providerIds: [ghostProvider], isActive: false },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      providers: { updatedCount: 0, unchangedCount: 0 },
      notFound: { gameIds: [ghostGame], providerIds: [ghostProvider] },
      unplayableGameIds: [],
    });
    const [row] = await db.drizzle.db.select().from(game).where(eq(game.id, target.id));
    expect(row?.isActive).toBe(false);
  });

  it('flags a game left active under a still-inactive provider as unplayable', async () => {
    const activeProvider = await seedProvider();
    const inactiveProvider = await seedProvider({ isActive: false });
    const targeted = await seedGame(activeProvider.id, { isActive: false });
    const strandedGame = await seedGame(inactiveProvider.id, { isActive: false });

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.setGamesActive,
      { gameIds: [targeted.id, strandedGame.id], isActive: true },
      { context: CTX },
    );

    expect(result.games).toEqual({ updatedCount: 2, unchangedCount: 0 });
    expect(result.unplayableGameIds).toEqual([strandedGame.id]);
  });

  it('repeating an identical call reports everything unchanged and emits no second event', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const { router, events } = routerWith(allowingGuard());

    await call(router.setGamesActive, { gameIds: [target.id], isActive: false }, { context: CTX });
    expect(events.emit).toHaveBeenCalledTimes(1);

    const second = await call(
      router.setGamesActive,
      { gameIds: [target.id], isActive: false },
      { context: CTX },
    );
    expect(second).toEqual({
      games: { updatedCount: 0, unchangedCount: 1 },
      providers: { updatedCount: 0, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
      unplayableGameIds: [],
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('addGameTags', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await seedTag();
    await expect(
      call(
        routerWith(denyingGuard()).router.addGameTags,
        { gameIds: [target.id], tagIds: [tag.id] },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await gameTagIdsFor(target.id)).toEqual([]);
  });

  it('adds tags by gameIds, by providerIds, and counts a mixed overlap once', async () => {
    const providerA = await seedProvider();
    const providerB = await seedProvider();
    const gA1 = await seedGame(providerA.id);
    const gA2 = await seedGame(providerA.id);
    const gB1 = await seedGame(providerB.id);
    const tag = await seedTag();

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.addGameTags,
      { gameIds: [gA1.id, gB1.id], providerIds: [providerA.id], tagIds: [tag.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 3, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameTagIdsFor(gA1.id)).toEqual([tag.id]);
    expect(await gameTagIdsFor(gA2.id)).toEqual([tag.id]);
    expect(await gameTagIdsFor(gB1.id)).toEqual([tag.id]);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.games.bulk_updated',
      expect.objectContaining({
        operation: 'add_tags',
        tagIds: [tag.id],
        addedLinks: [gA1.id, gA2.id, gB1.id].sort().map((gameId) => ({ gameId, tagIds: [tag.id] })),
      }),
    );
  });

  it('reports a nonexistent gameId in notFound while the rest still applies', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await seedTag();
    const ghostGame = randomUUID();

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.addGameTags,
      { gameIds: [target.id, ghostGame], tagIds: [tag.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [ghostGame], providerIds: [] },
    });
  });

  it('rejects the whole call with NOT_FOUND on an unknown tagId, writing nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const realTag = await seedTag();
    const ghostTag = randomUUID();

    const { router } = routerWith(allowingGuard());
    await expect(
      call(
        router.addGameTags,
        { gameIds: [target.id], tagIds: [realTag.id, ghostTag] },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await gameTagIdsFor(target.id)).toEqual([]);
  });

  it('is add-only: a pre-existing tag on another slot survives', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const existingTag = await seedTag();
    const newTag = await seedTag();
    await db.drizzle.db.insert(gameTagGame).values({ gameId: target.id, tagId: existingTag.id });

    const { router } = routerWith(allowingGuard());
    await call(router.addGameTags, { gameIds: [target.id], tagIds: [newTag.id] }, { context: CTX });

    expect(await gameTagIdsFor(target.id)).toEqual([existingTag.id, newTag.id].sort());
  });

  it('reports only the missing ids per game on a partial overlap', async () => {
    const provider = await seedProvider();
    const partial = await seedGame(provider.id);
    const fresh = await seedGame(provider.id);
    const tagA = await seedTag();
    const tagB = await seedTag();
    await db.drizzle.db.insert(gameTagGame).values({ gameId: partial.id, tagId: tagA.id });

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.addGameTags,
      { gameIds: [partial.id, fresh.id], tagIds: [tagA.id, tagB.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 2, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameTagIdsFor(partial.id)).toEqual([tagA.id, tagB.id].sort());
    expect(await gameTagIdsFor(fresh.id)).toEqual([tagA.id, tagB.id].sort());
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.games.bulk_updated',
      expect.objectContaining({
        addedLinks: [
          { gameId: partial.id, tagIds: [tagB.id] },
          { gameId: fresh.id, tagIds: [tagA.id, tagB.id].sort() },
        ].sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0)),
      }),
    );
  });

  it('repeating an identical call reports everything unchanged and emits no second event', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const tag = await seedTag();
    const { router, events } = routerWith(allowingGuard());

    await call(router.addGameTags, { gameIds: [target.id], tagIds: [tag.id] }, { context: CTX });
    expect(events.emit).toHaveBeenCalledTimes(1);

    const second = await call(
      router.addGameTags,
      { gameIds: [target.id], tagIds: [tag.id] },
      { context: CTX },
    );
    expect(second).toEqual({
      games: { updatedCount: 0, unchangedCount: 1 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('addGameCategories', () => {
  it('rejects a non-privileged caller and writes nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const category = await seedCategory();
    await expect(
      call(
        routerWith(denyingGuard()).router.addGameCategories,
        { gameIds: [target.id], categoryIds: [category.id] },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(await gameCategoryIdsFor(target.id)).toEqual([]);
  });

  it('adds categories by gameIds, by providerIds, and counts a mixed overlap once', async () => {
    const providerA = await seedProvider();
    const providerB = await seedProvider();
    const gA1 = await seedGame(providerA.id);
    const gA2 = await seedGame(providerA.id);
    const gB1 = await seedGame(providerB.id);
    const category = await seedCategory();

    const { router, events } = routerWith(allowingGuard());
    const result = await call(
      router.addGameCategories,
      { gameIds: [gA1.id, gB1.id], providerIds: [providerA.id], categoryIds: [category.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 3, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameCategoryIdsFor(gA1.id)).toEqual([category.id]);
    expect(await gameCategoryIdsFor(gA2.id)).toEqual([category.id]);
    expect(await gameCategoryIdsFor(gB1.id)).toEqual([category.id]);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'gaming.games.bulk_updated',
      expect.objectContaining({
        operation: 'add_categories',
        categoryIds: [category.id],
        addedLinks: [gA1.id, gA2.id, gB1.id]
          .sort()
          .map((gameId) => ({ gameId, categoryIds: [category.id] })),
      }),
    );
  });

  it('rejects the whole call with NOT_FOUND on an unknown categoryId, writing nothing', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const realCategory = await seedCategory();
    const ghostCategory = randomUUID();

    const { router } = routerWith(allowingGuard());
    await expect(
      call(
        router.addGameCategories,
        { gameIds: [target.id], categoryIds: [realCategory.id, ghostCategory] },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await gameCategoryIdsFor(target.id)).toEqual([]);
  });

  it('is add-only: a pre-existing category survives a second bulk add', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const existingCategory = await seedCategory();
    const newCategory = await seedCategory();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: target.id, categoryId: existingCategory.id });

    const { router } = routerWith(allowingGuard());
    await call(
      router.addGameCategories,
      { gameIds: [target.id], categoryIds: [newCategory.id] },
      { context: CTX },
    );

    expect(await gameCategoryIdsFor(target.id)).toEqual(
      [existingCategory.id, newCategory.id].sort(),
    );
  });

  it('reports a nonexistent providerId in notFound while the rest still applies', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const category = await seedCategory();
    const ghostProvider = randomUUID();

    const { router } = routerWith(allowingGuard());
    const result = await call(
      router.addGameCategories,
      { gameIds: [target.id], providerIds: [ghostProvider], categoryIds: [category.id] },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 1, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [ghostProvider] },
    });
  });
});

describe('bulk route 5,000-game cap', () => {
  it('rejects a call matching more than 5,000 games and writes nothing', async () => {
    const provider = await seedProvider();
    const gameIds = await seedManyGames(provider.id, 5001);
    const tag = await seedTag();
    const { router } = routerWith(allowingGuard());

    await expect(
      call(router.addGameTags, { providerIds: [provider.id], tagIds: [tag.id] }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await gameTagIdsFor(gameIds[0]!)).toEqual([]);
  }, 30_000);

  it('adds 7 tags across exactly 5,000 games (35,000 links, past the bind-parameter limit of a VALUES insert)', async () => {
    const provider = await seedProvider();
    const gameIds = await seedManyGames(provider.id, 5000);
    const tagIds = await seedManyTags(7);
    const { router } = routerWith(allowingGuard());

    const result = await call(
      router.addGameTags,
      { providerIds: [provider.id], tagIds },
      { context: CTX },
    );

    expect(result).toEqual({
      games: { updatedCount: 5000, unchangedCount: 0 },
      notFound: { gameIds: [], providerIds: [] },
    });
    expect(await gameTagIdsFor(gameIds[0]!)).toEqual([...tagIds].sort());
  }, 30_000);

  it('also caps setGamesActive and addGameCategories the same way', async () => {
    const provider = await seedProvider();
    await seedManyGames(provider.id, 5001);
    const category = await seedCategory();
    const { router } = routerWith(allowingGuard());

    await expect(
      call(
        router.setGamesActive,
        { providerIds: [provider.id], isActive: false },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      call(
        router.addGameCategories,
        { providerIds: [provider.id], categoryIds: [category.id] },
        { context: CTX },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }, 30_000);
});

describe('bulk route input validation', () => {
  it('rejects a target naming neither gameIds nor providerIds', async () => {
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.setGamesActive, { isActive: true } as never, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects an empty tagIds array', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.addGameTags, { gameIds: [target.id], tagIds: [] }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects when the guarded id is not even a UUID', async () => {
    const { router } = routerWith(allowingGuard());
    await expect(
      call(router.setGamesActive, { gameIds: [UNKNOWN_ID], providerIds: ['not-a-uuid'] } as never, {
        context: CTX,
      }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
