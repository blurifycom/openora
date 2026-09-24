import { GameSortService, GameSortConfigInvalidError } from '../service/game-sort.service.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  createGameSortCatalog,
  defineGameSort,
  type GameSortCatalog,
} from '@openora/core/contracts';
import { NO_CLIENT_META, makeEventBus, makeJobQueue } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { createDefaultGameSorts } from '../adapters/sort/index.js';
import {
  GameCategoryService,
  GameCategoryNotFoundError,
  GameCategorySlugTakenError,
  CategoryGameNotMemberError,
} from '../service/game-category.service.js';

let db: TestDb;

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

function makeService(sortCatalog?: GameSortCatalog) {
  const events = makeEventBus();
  const jobQueue = makeJobQueue();
  const catalog = sortCatalog ?? createGameSortCatalog(createDefaultGameSorts(db.drizzle));
  return {
    svc: new GameCategoryService(db.drizzle, events, jobQueue, new GameSortService(catalog)),
    events,
    jobQueue,
  };
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Category', ...overrides })
    .returning();
  return row!;
}

async function seedProvider() {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive: true })
    .returning();
  return row!;
}

async function seedGame(
  providerId: string,
  overrides: Partial<typeof game.$inferInsert> = {},
  categoryIds: string[] = [],
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
  if (categoryIds.length > 0) {
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values(categoryIds.map((categoryId) => ({ gameId: row!.id, categoryId })));
  }
  return row!;
}

async function setRank(categoryId: string, gameId: string, rank: number) {
  await db.drizzle.db
    .update(gameCategoryGame)
    .set({ rank })
    .where(
      sql`${gameCategoryGame.categoryId} = ${categoryId} AND ${gameCategoryGame.gameId} = ${gameId}`,
    );
}

async function pinGame(categoryId: string, gameId: string, position: number) {
  await db.drizzle.db
    .update(gameCategoryGame)
    .set({ pinnedPosition: position })
    .where(
      sql`${gameCategoryGame.categoryId} = ${categoryId} AND ${gameCategoryGame.gameId} = ${gameId}`,
    );
}

async function memberRows(categoryId: string) {
  return db.drizzle.db
    .select({
      gameId: gameCategoryGame.gameId,
      position: gameCategoryGame.position,
      pinnedPosition: gameCategoryGame.pinnedPosition,
    })
    .from(gameCategoryGame)
    .where(eq(gameCategoryGame.categoryId, categoryId))
    .orderBy(asc(gameCategoryGame.gameId));
}

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameCategoryGame}, ${game}, ${gameCategory}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('GameCategoryService (real PG)', () => {
  it('listActiveCategories pages only active categories ordered by sortOrder', async () => {
    await seedCategory({ slug: 'b-cat', name: 'B', sortOrder: 2 });
    await seedCategory({ slug: 'a-cat', name: 'A', sortOrder: 1 });
    await seedCategory({ slug: 'old-cat', name: 'Old', isActive: false, sortOrder: 0 });

    const { svc } = makeService();
    const firstPage = await svc.listActiveCategories({ page: 1, limit: 1 });

    expect(firstPage).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(firstPage.items.map((r) => r.slug)).toEqual(['a-cat']);
    const secondPage = await svc.listActiveCategories({ page: 2, limit: 1 });
    expect(secondPage.items.map((r) => r.slug)).toEqual(['b-cat']);
  });

  it('createCategory stores the row with defaults and emits an event', async () => {
    const { svc, events } = makeService();

    const created = await svc.createCategory({
      slug: 'table-games',
      name: 'Table Games',
      ...ACTOR,
    });

    expect(created).toMatchObject({
      slug: 'table-games',
      name: 'Table Games',
      icon: null,
      sortOrder: 0,
      isActive: true,
      translations: {},
    });
    expect(emittedTopics(events)).toContain('gaming.category.created');
  });

  it('createCategory rejects a duplicate slug', async () => {
    await seedCategory({ slug: 'slots' });
    const { svc } = makeService();

    await expect(
      svc.createCategory({ slug: 'slots', name: 'Slots 2', ...ACTOR }),
    ).rejects.toBeInstanceOf(GameCategorySlugTakenError);
  });

  it('updateCategory patches fields and rejects a taken slug', async () => {
    const created = await seedCategory({ slug: 'slots', name: 'Slots' });
    await seedCategory({ slug: 'live' });
    const { svc, events } = makeService();

    const updated = await svc.updateCategory({
      id: created.id,
      name: 'Slot Machines',
      icon: 'slots.png',
      sortOrder: 3,
      ...ACTOR,
    });

    expect(updated).toMatchObject({ slug: 'slots', name: 'Slot Machines', sortOrder: 3 });
    expect(emittedTopics(events)).toContain('gaming.category.updated');
    await expect(
      svc.updateCategory({ id: created.id, slug: 'live', ...ACTOR }),
    ).rejects.toBeInstanceOf(GameCategorySlugTakenError);
    await expect(
      svc.updateCategory({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'X',
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameCategoryNotFoundError);
  });

  it('replaces, preserves, and clears the full translations map', async () => {
    const created = await seedCategory({
      slug: 'slots',
      name: 'Slots',
      translations: { de: { name: 'Automaten' }, fr: { name: 'Machines à sous' } },
    });
    const { svc } = makeService();

    const replaced = await svc.updateCategory({
      id: created.id,
      translations: { de: { name: 'Spielautomaten' } },
      ...ACTOR,
    });
    expect(replaced.translations).toEqual({ de: { name: 'Spielautomaten' } });

    const renamed = await svc.updateCategory({
      id: created.id,
      name: 'Slot Machines',
      ...ACTOR,
    });
    expect(renamed.translations).toEqual({ de: { name: 'Spielautomaten' } });

    const cleared = await svc.updateCategory({
      id: created.id,
      translations: {},
      ...ACTOR,
    });
    expect(cleared.translations).toEqual({});

    const [stored] = await db.drizzle.db
      .select({ translations: gameCategory.translations })
      .from(gameCategory)
      .where(eq(gameCategory.id, created.id));
    expect(stored?.translations).toEqual({});
  });

  it('getCategory 404s an unknown id', async () => {
    const { svc } = makeService();
    await expect(svc.getCategory('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      GameCategoryNotFoundError,
    );
  });

  it('getActiveCategoryBySlug resolves only an active category by slug', async () => {
    await seedCategory({ slug: 'slots', name: 'Slots' });
    await seedCategory({ slug: 'hidden', name: 'Hidden', isActive: false });
    const { svc } = makeService();

    await expect(svc.getActiveCategoryBySlug('slots')).resolves.toMatchObject({
      slug: 'slots',
      name: 'Slots',
      translations: {},
    });
    await expect(svc.getActiveCategoryBySlug('hidden')).rejects.toBeInstanceOf(
      GameCategoryNotFoundError,
    );
    await expect(svc.getActiveCategoryBySlug('unknown')).rejects.toBeInstanceOf(
      GameCategoryNotFoundError,
    );
  });
});

describe('GameCategoryService.reorderCategoryGames (real PG)', () => {
  it('switches the category to manual sort, seeds unlisted members from their effective order, and leaves pins untouched', async () => {
    const category = await seedCategory({ sortKey: 'name', sortDirection: 'asc' });
    const provider = await seedProvider();
    const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
    const bravo = await seedGame(provider.id, { name: 'Bravo' }, [category.id]);
    const charlie = await seedGame(provider.id, { name: 'Charlie' }, [category.id]);
    await setRank(category.id, alpha.id, 0);
    await setRank(category.id, bravo.id, 1);
    await setRank(category.id, charlie.id, 2);
    await pinGame(category.id, charlie.id, 0);

    const { svc, events } = makeService();
    const result = await svc.reorderCategoryGames({
      id: category.id,
      gameIds: [bravo.id],
      ...ACTOR,
    });

    expect(result).toEqual({
      sortKey: 'manual',
      sortDirection: null,
      sortParams: {},
    });
    await expect(svc.getCategory(category.id)).resolves.toMatchObject({
      sortKey: 'manual',
      sortDirection: null,
      sortParams: {},
    });

    const rows = await memberRows(category.id);
    const byId = new Map(rows.map((r) => [r.gameId, r]));
    expect(byId.get(bravo.id)?.position).toBe(0);
    expect(byId.get(alpha.id)?.position).toBe(1);
    expect(byId.get(charlie.id)?.position).toBe(2);
    expect(byId.get(charlie.id)?.pinnedPosition).toBe(0);

    const reorderedCall = events.emit.mock.calls.find(
      ([topic]) => topic === 'gaming.category.games_reordered',
    );
    expect(reorderedCall?.[1]).toMatchObject({
      sortKeyBefore: 'name',
      sortKeyAfter: 'manual',
      sortDirectionBefore: 'asc',
      sortDirectionAfter: null,
      sortParamsBefore: {},
      sortParamsAfter: {},
      // The full pre-drag effective order (rank asc: alpha, bravo, charlie), not only
      // the members that already had a manual position - and the full resulting order,
      // not only the dragged ids.
      before: [alpha.id, bravo.id, charlie.id],
      after: [bravo.id, alpha.id, charlie.id],
    });
  });

  it("audits the full pre-drag order via the name/id fallback on a category's first-ever drag, never an empty list", async () => {
    const category = await seedCategory({ sortKey: 'manual' });
    const provider = await seedProvider();
    const alpha = await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
    const bravo = await seedGame(provider.id, { name: 'Bravo' }, [category.id]);
    // Neither game has ever been ranked or manually positioned before.

    const { svc, events } = makeService();
    await svc.reorderCategoryGames({
      id: category.id,
      gameIds: [bravo.id],
      ...ACTOR,
    });

    const reorderedCall = events.emit.mock.calls.find(
      ([topic]) => topic === 'gaming.category.games_reordered',
    );
    expect(reorderedCall?.[1]).toMatchObject({
      before: [alpha.id, bravo.id],
      after: [bravo.id, alpha.id],
    });
  });

  it('rejects when manual is unbound in the sort catalog, writing nothing', async () => {
    const category = await seedCategory({ sortKey: 'name' });
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id, {}, [category.id]);
    const nameOnlyCatalog = createGameSortCatalog([
      defineGameSort({
        key: 'name',
        directions: ['asc', 'desc'],
        paramsSchema: z.object({}),
        async rank({ gameIds }) {
          return gameIds;
        },
      }),
    ]);
    const { svc } = makeService(nameOnlyCatalog);

    await expect(
      svc.reorderCategoryGames({
        id: category.id,
        gameIds: [g1.id],
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(GameSortConfigInvalidError);

    const [row] = await db.drizzle.db
      .select({ sortKey: gameCategory.sortKey })
      .from(gameCategory)
      .where(eq(gameCategory.id, category.id));
    expect(row).toMatchObject({ sortKey: 'name' });
  });
});

describe('GameCategoryService.updateCategoryPins (real PG)', () => {
  it('replaces all pins in one request and audits ordered by position', async () => {
    const category = await seedCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id, { name: 'G1' }, [category.id]);
    const g2 = await seedGame(provider.id, { name: 'G2' }, [category.id]);
    const { svc, events } = makeService();

    const result = await svc.updateCategoryPins({
      id: category.id,
      pins: [
        { gameId: g2.id, position: 0 },
        { gameId: g1.id, position: 1 },
      ],
      ...ACTOR,
    });
    expect(result).toEqual({
      pins: [
        { gameId: g2.id, position: 0 },
        { gameId: g1.id, position: 1 },
      ],
    });

    const rows = await memberRows(category.id);
    const byId = new Map(rows.map((r) => [r.gameId, r.pinnedPosition]));
    expect(byId.get(g2.id)).toBe(0);
    expect(byId.get(g1.id)).toBe(1);

    const pinsCall = events.emit.mock.calls.find(
      ([topic]) => topic === 'gaming.category.pins_updated',
    );
    expect(pinsCall?.[1]).toMatchObject({
      before: [],
      after: [
        { gameId: g2.id, position: 0 },
        { gameId: g1.id, position: 1 },
      ],
    });
  });

  it('swaps two games pinned slots in one request without a constraint violation', async () => {
    const category = await seedCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id, {}, [category.id]);
    const g2 = await seedGame(provider.id, {}, [category.id]);
    await pinGame(category.id, g1.id, 0);
    await pinGame(category.id, g2.id, 1);
    const { svc } = makeService();

    await svc.updateCategoryPins({
      id: category.id,
      pins: [
        { gameId: g1.id, position: 1 },
        { gameId: g2.id, position: 0 },
      ],
      ...ACTOR,
    });

    const rows = await memberRows(category.id);
    const byId = new Map(rows.map((r) => [r.gameId, r.pinnedPosition]));
    expect(byId.get(g1.id)).toBe(1);
    expect(byId.get(g2.id)).toBe(0);
  });

  it('an empty pins array unpins every game', async () => {
    const category = await seedCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id, {}, [category.id]);
    await pinGame(category.id, g1.id, 0);
    const { svc } = makeService();

    await svc.updateCategoryPins({
      id: category.id,
      pins: [],
      ...ACTOR,
    });

    const rows = await memberRows(category.id);
    expect(rows.every((r) => r.pinnedPosition === null)).toBe(true);
  });

  it('rejects a gameId that is not a member, writing nothing', async () => {
    const category = await seedCategory();
    const provider = await seedProvider();
    const member = await seedGame(provider.id, {}, [category.id]);
    const outsider = await seedGame(provider.id);
    const { svc } = makeService();

    await expect(
      svc.updateCategoryPins({
        id: category.id,
        pins: [
          { gameId: member.id, position: 0 },
          { gameId: outsider.id, position: 1 },
        ],
        ...ACTOR,
      }),
    ).rejects.toBeInstanceOf(CategoryGameNotMemberError);

    const rows = await memberRows(category.id);
    expect(rows.every((r) => r.pinnedPosition === null)).toBe(true);
  });

  it('drops a pin when its game is removed from the category', async () => {
    const category = await seedCategory();
    const provider = await seedProvider();
    const g1 = await seedGame(provider.id, {}, [category.id]);
    await pinGame(category.id, g1.id, 0);

    await db.drizzle.db
      .delete(gameCategoryGame)
      .where(
        sql`${gameCategoryGame.categoryId} = ${category.id} AND ${gameCategoryGame.gameId} = ${g1.id}`,
      );

    const rows = await memberRows(category.id);
    expect(rows).toEqual([]);
  });
});
