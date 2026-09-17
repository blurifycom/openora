import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import { GameCatalogReaderService } from '../adapters/game-catalog-reader.service.js';

let db: TestDb;
let reader: GameCatalogReaderService;

const NOT_A_UUID = 'not-a-uuid';

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive: true, ...overrides })
      .returning(),
    new Error('seedProvider: query returned no row'),
  );
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: `category-${randomUUID()}`, name: 'Category', ...overrides })
      .returning(),
    new Error('seedCategory: query returned no row'),
  );
}

async function seedGame(
  providerId: string,
  overrides: Partial<typeof game.$inferInsert> = {},
  categoryIds: string[] = [],
) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        name: 'Game',
        slug: `game-${randomUUID()}`,
        providerId,
        aggregator: 'direct',
        isActive: true,
        ...overrides,
      })
      .returning(),
    new Error('seedGame: query returned no row'),
  );
  if (categoryIds.length > 0) {
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values(categoryIds.map((categoryId) => ({ gameId: row.id, categoryId })));
  }
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  reader = new GameCatalogReaderService(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameCategoryGame}, ${game}, ${gameCategory}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('GameCatalogReaderService.getPlayableGames (real PG)', () => {
  it('returns only games whose game and provider are both active, keyed by id', async () => {
    const provider = await seedProvider({ name: 'Studio', logoUrl: 'https://cdn/logo.png' });
    const disabledProvider = await seedProvider({ isActive: false });
    const playable = await seedGame(provider.id, {
      name: 'Playable',
      thumbnailUrl: 'https://cdn/thumb.png',
    });
    const inactive = await seedGame(provider.id, { isActive: false });
    const ofDisabledProvider = await seedGame(disabledProvider.id);

    const games = await reader.getPlayableGames([
      playable.id,
      inactive.id,
      ofDisabledProvider.id,
      randomUUID(),
      NOT_A_UUID,
      playable.id,
    ]);

    expect([...games.keys()]).toEqual([playable.id]);
    expect(games.get(playable.id)).toEqual({
      id: playable.id,
      name: 'Playable',
      slug: playable.slug,
      thumbnailUrl: 'https://cdn/thumb.png',
      provider: {
        id: provider.id,
        slug: provider.slug,
        name: 'Studio',
        logoUrl: 'https://cdn/logo.png',
      },
    });
  });

  it('iterates in the order the ids were given', async () => {
    const provider = await seedProvider();
    const alpha = await seedGame(provider.id, { name: 'Alpha' });
    const bravo = await seedGame(provider.id, { name: 'Bravo' });
    const charlie = await seedGame(provider.id, { name: 'Charlie' });

    const games = await reader.getPlayableGames([charlie.id, alpha.id, bravo.id]);

    expect([...games.keys()]).toEqual([charlie.id, alpha.id, bravo.id]);
  });

  it('returns an empty map for no ids', async () => {
    expect(await reader.getPlayableGames([])).toEqual(new Map());
  });
});

describe('GameCatalogReaderService.listPlayableGamesInCategory (real PG)', () => {
  it('lists playable games of the category ordered by name, up to the limit', async () => {
    const provider = await seedProvider();
    const disabledProvider = await seedProvider({ isActive: false });
    const category = await seedCategory();
    const other = await seedCategory();
    await seedGame(provider.id, { name: 'Charlie' }, [category.id]);
    await seedGame(provider.id, { name: 'Alpha' }, [category.id]);
    await seedGame(provider.id, { name: 'Bravo' }, [category.id]);
    await seedGame(provider.id, { name: 'Aardvark', isActive: false }, [category.id]);
    await seedGame(disabledProvider.id, { name: 'Abacus' }, [category.id]);
    await seedGame(provider.id, { name: 'Aaron' }, [other.id]);

    const games = await reader.listPlayableGamesInCategory(category.id, { limit: 2 });

    expect(games.map((g) => g.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('returns nothing for an inactive category, an unknown or malformed id, or a limit below 1', async () => {
    const provider = await seedProvider();
    const inactive = await seedCategory({ isActive: false });
    const active = await seedCategory();
    await seedGame(provider.id, {}, [inactive.id, active.id]);

    expect(await reader.listPlayableGamesInCategory(inactive.id, { limit: 10 })).toEqual([]);
    expect(await reader.listPlayableGamesInCategory(randomUUID(), { limit: 10 })).toEqual([]);
    expect(await reader.listPlayableGamesInCategory(NOT_A_UUID, { limit: 10 })).toEqual([]);
    expect(await reader.listPlayableGamesInCategory(active.id, { limit: 0 })).toEqual([]);
  });
});

describe('GameCatalogReaderService.getActiveCategories (real PG)', () => {
  it('returns only active categories, with their translations', async () => {
    const active = await seedCategory({
      name: 'Slots',
      icon: 'slot',
      sortOrder: 3,
      translations: { de: { name: 'Spielautomaten' } },
    });
    const inactive = await seedCategory({ isActive: false });

    const categories = await reader.getActiveCategories([
      active.id,
      inactive.id,
      randomUUID(),
      NOT_A_UUID,
    ]);

    expect([...categories.keys()]).toEqual([active.id]);
    expect(categories.get(active.id)).toEqual({
      id: active.id,
      slug: active.slug,
      name: 'Slots',
      icon: 'slot',
      sortOrder: 3,
      translations: { de: { name: 'Spielautomaten' } },
    });
  });

  it('adds the playable game count when asked, keeping id order and zero counts', async () => {
    const provider = await seedProvider();
    const disabledProvider = await seedProvider({ isActive: false });
    const slots = await seedCategory({ name: 'Slots' });
    const unlinked = await seedCategory({ name: 'Unlinked' });
    const retired = await seedCategory({ name: 'Retired', isActive: false });
    await seedGame(provider.id, {}, [slots.id, retired.id]);
    await seedGame(provider.id, {}, [slots.id]);
    await seedGame(provider.id, { isActive: false }, [slots.id]);
    await seedGame(disabledProvider.id, {}, [slots.id]);

    const categories = await reader.getActiveCategories([unlinked.id, retired.id, slots.id], {
      withGameCount: true,
    });

    expect([...categories.values()]).toMatchObject([
      { id: unlinked.id, name: 'Unlinked', gameCount: 0 },
      { id: slots.id, name: 'Slots', gameCount: 2 },
    ]);
  });

  it('iterates in the order the ids were given, not by sortOrder', async () => {
    const first = await seedCategory({ sortOrder: 1 });
    const second = await seedCategory({ sortOrder: 2 });
    const third = await seedCategory({ sortOrder: 3 });

    const categories = await reader.getActiveCategories([second.id, third.id, first.id]);

    expect([...categories.keys()]).toEqual([second.id, third.id, first.id]);
  });
});

describe('GameCatalogReaderService.getActiveProviders (real PG)', () => {
  it('returns only active providers, in the order the ids were given', async () => {
    const zeta = await seedProvider({ name: 'Zeta', logoUrl: 'https://cdn/zeta.png' });
    const alpha = await seedProvider({ name: 'Alpha' });
    const disabled = await seedProvider({ isActive: false });

    const providers = await reader.getActiveProviders([
      alpha.id,
      disabled.id,
      randomUUID(),
      NOT_A_UUID,
      zeta.id,
      alpha.id,
    ]);

    expect([...providers.keys()]).toEqual([alpha.id, zeta.id]);
    expect(providers.get(zeta.id)).toEqual({
      id: zeta.id,
      slug: zeta.slug,
      name: 'Zeta',
      logoUrl: 'https://cdn/zeta.png',
    });
  });

  it('returns an empty map for no ids', async () => {
    expect(await reader.getActiveProviders([])).toEqual(new Map());
  });
});

describe('GameCatalogReaderService.getCategoryIdsByGame (real PG)', () => {
  it('maps each game to its active category ids and omits games with none', async () => {
    const provider = await seedProvider();
    const slots = await seedCategory();
    const live = await seedCategory();
    const retired = await seedCategory({ isActive: false });
    const inBoth = await seedGame(provider.id, {}, [slots.id, live.id, retired.id]);
    const onlyRetired = await seedGame(provider.id, {}, [retired.id]);
    const uncategorized = await seedGame(provider.id);

    const byGame = await reader.getCategoryIdsByGame([
      inBoth.id,
      onlyRetired.id,
      uncategorized.id,
      NOT_A_UUID,
    ]);

    expect([...byGame.keys()]).toEqual([inBoth.id]);
    expect(byGame.get(inBoth.id)).toEqual(new Set([slots.id, live.id]));
  });
  it('iterates in the order the game ids were given', async () => {
    const provider = await seedProvider();
    const slots = await seedCategory();
    const first = await seedGame(provider.id, {}, [slots.id]);
    const second = await seedGame(provider.id, {}, [slots.id]);
    const third = await seedGame(provider.id, {}, [slots.id]);

    const byGame = await reader.getCategoryIdsByGame([third.id, first.id, second.id]);

    expect([...byGame.keys()]).toEqual([third.id, first.id, second.id]);
  });
});

describe('GameCatalogReaderService.listActiveCategoriesWithGameCount (real PG)', () => {
  it('counts only playable games per active category, ordered by sortOrder then name', async () => {
    const provider = await seedProvider();
    const disabledProvider = await seedProvider({ isActive: false });
    const live = await seedCategory({ name: 'Live', sortOrder: 2 });
    const slots = await seedCategory({ name: 'Slots', sortOrder: 1 });
    const unplayable = await seedCategory({ name: 'Unplayable', sortOrder: 2 });
    await seedCategory({ name: 'Unlinked', sortOrder: 3 });
    const retired = await seedCategory({ name: 'Retired', sortOrder: 0, isActive: false });
    await seedGame(provider.id, {}, [slots.id, live.id, retired.id]);
    await seedGame(provider.id, {}, [slots.id]);
    await seedGame(provider.id, { isActive: false }, [slots.id]);
    await seedGame(disabledProvider.id, {}, [slots.id, unplayable.id]);

    const categories = await reader.listActiveCategoriesWithGameCount({ page: 1, limit: 100 });

    expect(categories.items.map(({ name, gameCount }) => ({ name, gameCount }))).toEqual([
      { name: 'Slots', gameCount: 2 },
      { name: 'Live', gameCount: 1 },
      { name: 'Unplayable', gameCount: 0 },
      { name: 'Unlinked', gameCount: 0 },
    ]);
    expect(categories.total).toBe(4);
  });

  it('pages active categories, with the total counting every active category', async () => {
    await seedCategory({ name: 'Slots', sortOrder: 1 });
    await seedCategory({ name: 'Live', sortOrder: 2 });
    await seedCategory({ name: 'Table', sortOrder: 3 });
    await seedCategory({ name: 'Retired', sortOrder: 0, isActive: false });

    const secondPage = await reader.listActiveCategoriesWithGameCount({ page: 2, limit: 2 });

    expect(secondPage.items.map((c) => c.name)).toEqual(['Table']);
    expect(secondPage).toMatchObject({ total: 3, page: 2, limit: 2 });
  });

  it('returns no items when page or limit is below 1', async () => {
    await seedCategory();

    const zeroLimit = await reader.listActiveCategoriesWithGameCount({ page: 1, limit: 0 });
    const zeroPage = await reader.listActiveCategoriesWithGameCount({ page: 0, limit: 10 });

    expect(zeroLimit).toMatchObject({ items: [], total: 1 });
    expect(zeroPage).toMatchObject({ items: [], total: 1 });
  });
});

describe('GameCatalogReaderService.listActiveProviders (real PG)', () => {
  it('lists active providers ordered by name', async () => {
    await seedProvider({ name: 'Zeta' });
    await seedProvider({ name: 'Alpha' });
    await seedProvider({ name: 'Beta', isActive: false });

    const providers = await reader.listActiveProviders({ page: 1, limit: 100 });

    expect(providers.items.map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
    expect(providers.total).toBe(2);
  });

  it('pages active providers, with the total counting every active provider', async () => {
    await seedProvider({ name: 'Zeta' });
    await seedProvider({ name: 'Alpha' });
    await seedProvider({ name: 'Mu' });
    await seedProvider({ name: 'Beta', isActive: false });

    const secondPage = await reader.listActiveProviders({ page: 2, limit: 2 });

    expect(secondPage.items.map((p) => p.name)).toEqual(['Zeta']);
    expect(secondPage).toMatchObject({ total: 3, page: 2, limit: 2 });
  });

  it('returns no items when page or limit is below 1', async () => {
    await seedProvider();

    const zeroLimit = await reader.listActiveProviders({ page: 1, limit: 0 });
    const zeroPage = await reader.listActiveProviders({ page: -1, limit: 10 });

    expect(zeroLimit).toMatchObject({ items: [], total: 1 });
    expect(zeroPage).toMatchObject({ items: [], total: 1 });
  });
});
