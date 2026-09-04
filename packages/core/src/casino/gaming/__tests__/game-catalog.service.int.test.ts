import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { NO_CLIENT_META, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { game, gameCategory, gameCategoryGame, gameProvider, gameRound } from '../schema/index.js';
import { GameCatalogService, GameSlugTakenError } from '../service/game-catalog.service.js';
import { GameProviderNotFoundError } from '../service/game-provider.service.js';
import { GameCategoryNotFoundError } from '../service/game-category.service.js';
import { GameNotFoundError } from '../service/gaming.service.js';

let db: TestDb;

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

function makeService() {
  const events = makeEventBus();
  return { svc: new GameCatalogService(db.drizzle, events), events };
}

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameProvider)
    .values({ slug: `studio-${randomUUID()}`, name: 'Studio', ...overrides })
    .returning();
  return row!;
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Category', ...overrides })
    .returning();
  return row!;
}

async function seedGame(overrides: Partial<typeof game.$inferInsert> = {}, categoryIds?: string[]) {
  const provider = await seedProvider();
  const ids = categoryIds ?? [(await seedCategory()).id];
  const [row] = await db.drizzle.db
    .insert(game)
    .values({
      name: 'Game',
      slug: `game-${randomUUID()}`,
      providerId: provider.id,
      aggregator: 'direct',
      ...overrides,
    })
    .returning();
  await db.drizzle.db
    .insert(gameCategoryGame)
    .values(ids.map((categoryId) => ({ gameId: row!.id, categoryId })));
  return row!;
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
    sql`TRUNCATE ${gameRound}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
  );
});

describe('GameCatalogService updateGame (real PG)', () => {
  it('patches scalar fields and emits an event', async () => {
    const created = await seedGame({ name: 'Roulette' });
    const { svc, events } = makeService();

    const updated = await svc.updateGame({
      id: created.id,
      name: 'Roulette Gold',
      isActive: false,
      ...ACTOR,
    });

    expect(updated).toMatchObject({ name: 'Roulette Gold', isActive: false });
    expect(emittedTopics(events)).toContain('gaming.game.updated');
  });

  it('replaces the category set, including clearing it with an empty array', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const blackjack = await seedCategory({ slug: 'blackjack', name: 'Blackjack' });
    const created = await seedGame({}, [table.id, blackjack.id]);
    const { svc } = makeService();

    const replaced = await svc.updateGame({
      id: created.id,
      categoryIds: [blackjack.id],
      ...NO_CLIENT_META,
    });
    expect(replaced.categories.map((c) => c.slug)).toEqual(['blackjack']);

    const cleared = await svc.updateGame({ id: created.id, categoryIds: [], ...NO_CLIENT_META });
    expect(cleared.categories).toEqual([]);
  });

  it('leaves links untouched when categoryIds is omitted', async () => {
    const table = await seedCategory({ slug: 'table-games', name: 'Table Games' });
    const created = await seedGame({}, [table.id]);
    const { svc } = makeService();

    const updated = await svc.updateGame({ id: created.id, name: 'Renamed', ...NO_CLIENT_META });
    expect(updated.categories.map((c) => c.slug)).toEqual(['table-games']);
  });

  it('reassigns the provider and validates all references', async () => {
    const created = await seedGame();
    const other = await seedProvider({ slug: 'other-studio', name: 'Other' });
    const { svc } = makeService();

    const updated = await svc.updateGame({
      id: created.id,
      providerId: other.id,
      ...NO_CLIENT_META,
    });
    expect(updated.provider).toMatchObject({ slug: 'other-studio' });

    await expect(
      svc.updateGame({
        id: created.id,
        providerId: '00000000-0000-4000-8000-000000000000',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameProviderNotFoundError);
    await expect(
      svc.updateGame({
        id: created.id,
        categoryIds: ['00000000-0000-4000-8000-000000000000'],
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameCategoryNotFoundError);
    await expect(
      svc.updateGame({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'X',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameNotFoundError);
  });

  it('rejects a taken game slug', async () => {
    const created = await seedGame({ slug: 'game-one' });
    await seedGame({ slug: 'game-two' });
    const { svc } = makeService();

    await expect(
      svc.updateGame({ id: created.id, slug: 'game-two', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(GameSlugTakenError);
  });
});
