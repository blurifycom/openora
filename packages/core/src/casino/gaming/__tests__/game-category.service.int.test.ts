import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { NO_CLIENT_META, makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { gameCategory } from '../schema/index.js';
import {
  GameCategoryService,
  GameCategoryNotFoundError,
  GameCategorySlugTakenError,
} from '../service/game-category.service.js';

let db: TestDb;

const ACTOR = { actorId: '00000000-0000-4000-8000-000000000001', ...NO_CLIENT_META };

function makeService() {
  const events = makeEventBus();
  return { svc: new GameCategoryService(db.drizzle, events), events };
}

async function seedCategory(overrides: Partial<typeof gameCategory.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(gameCategory)
    .values({ slug: `category-${randomUUID()}`, name: 'Category', ...overrides })
    .returning();
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
  await db.drizzle.db.execute(sql`TRUNCATE ${gameCategory} RESTART IDENTITY CASCADE`);
});

describe('GameCategoryService (real PG)', () => {
  it('listActiveCategories returns only active categories ordered by sortOrder', async () => {
    await seedCategory({ slug: 'b-cat', name: 'B', sortOrder: 2 });
    await seedCategory({ slug: 'a-cat', name: 'A', sortOrder: 1 });
    await seedCategory({ slug: 'old-cat', name: 'Old', isActive: false, sortOrder: 0 });

    const { svc } = makeService();
    const rows = await svc.listActiveCategories();

    expect(rows.map((r) => r.slug)).toEqual(['a-cat', 'b-cat']);
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
      svc.createCategory({ slug: 'slots', name: 'Slots 2', ...NO_CLIENT_META }),
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
      svc.updateCategory({ id: created.id, slug: 'live', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(GameCategorySlugTakenError);
    await expect(
      svc.updateCategory({
        id: '00000000-0000-4000-8000-000000000000',
        name: 'X',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(GameCategoryNotFoundError);
  });

  it('replaces, preserves, and clears the full translations map', async () => {
    const created = await seedCategory({
      slug: 'slots',
      name: 'Slots',
      translations: { DE: { name: 'Automaten' }, FR: { name: 'Machines à sous' } },
    });
    const { svc } = makeService();

    const replaced = await svc.updateCategory({
      id: created.id,
      translations: { DE: { name: 'Spielautomaten' } },
      ...NO_CLIENT_META,
    });
    expect(replaced.translations).toEqual({ DE: { name: 'Spielautomaten' } });

    const renamed = await svc.updateCategory({
      id: created.id,
      name: 'Slot Machines',
      ...NO_CLIENT_META,
    });
    expect(renamed.translations).toEqual({ DE: { name: 'Spielautomaten' } });

    const cleared = await svc.updateCategory({
      id: created.id,
      translations: {},
      ...NO_CLIENT_META,
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
