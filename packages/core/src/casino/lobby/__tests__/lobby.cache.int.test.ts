import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { RedisCache } from '@openora/core/server';
import { createLobbySectionCatalog } from '@openora/core/contracts';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameProvider,
} from '@openora/core/casino/schema/gaming';
import { migrate as migrateGaming } from '@openora/core/casino/migrate/gaming';
import { migrate as migrateLobby } from '@openora/core/casino/migrate/lobby';
import { makeEventBus } from '../../../testing/mock.js';
import {
  featuredSlot,
  lobbyCategory,
  lobbyCategoryGame,
  lobbyLayout,
  lobbySection,
} from '../schema/index.js';
import { LobbyService } from '../service/lobby.service.js';

const configSchema = z.object({ value: z.string() });

function makeLobbyService(cache?: RedisCache) {
  return new LobbyService(db.drizzle, makeEventBus(), createLobbySectionCatalog([]), cache);
}

let db: TestDb;
let redis: TestRedis;

beforeAll(async () => {
  db = await createTestDb([migrateGaming, migrateLobby]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${lobbySection}, ${lobbyLayout}, ${featuredSlot}, ${lobbyCategoryGame}, ${lobbyCategory}, ${gameCategoryGame}, ${game}, ${gameProvider}, ${gameCategory} RESTART IDENTITY CASCADE`,
  );
  await redis.flush();
});

describe('LobbyService featured cache (real PG + real Redis)', () => {
  it('serves the second read from cache under a 30s TTL, ignoring later DB writes', async () => {
    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: 'acme-studio', name: 'Acme Studio', isActive: true })
      .returning();
    const [category] = await db.drizzle.db
      .insert(gameCategory)
      .values({ slug: 'slots', name: 'Slots' })
      .returning();
    const [g] = await db.drizzle.db
      .insert(game)
      .values({
        name: 'Aces',
        slug: 'aces',
        providerId: provider!.id,
        aggregator: 'direct',
        thumbnailUrl: 'aces.png',
        isActive: true,
      })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: g!.id, categoryId: category!.id });
    const [slot] = await db.drizzle.db
      .insert(featuredSlot)
      .values({ gameId: g.id, title: 'Big Win', placement: 'home', sortOrder: 0, isActive: true })
      .returning();

    const svc = makeLobbyService(new RedisCache(redis.client));

    const first = await svc.getFeatured();
    expect(first).toEqual([
      {
        id: slot.id,
        title: 'Big Win',
        gameId: g.id,
        gameName: 'Aces',
        thumbnailUrl: 'aces.png',
        placement: 'home',
        sortOrder: 0,
      },
    ]);

    const pttl = await redis.client.pTTL('cache:lobby:featured');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30_000);

    // TTL-only cache (no invalidation): a direct DB write stays invisible until the TTL lapses.
    await db.drizzle.db.update(game).set({ name: 'Renamed' }).where(eq(game.id, g.id));
    const second = await svc.getFeatured();
    expect(second).toEqual(first);
  });
});

describe('LobbyService public game gates (real PG)', () => {
  async function seedPlayableGame(name: string) {
    const tag = randomUUID();
    const [provider] = await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `studio-${tag}`, name: `${name} Studio`, isActive: true })
      .returning();
    const [row] = await db.drizzle.db
      .insert(game)
      .values({
        name,
        slug: `game-${tag}`,
        providerId: provider!.id,
        aggregator: 'direct',
        isActive: true,
      })
      .returning();
    return { provider: provider!, row: row! };
  }

  it('search hides inactive games and games of deactivated providers', async () => {
    await seedPlayableGame('Gate Search Live');
    const dark = await seedPlayableGame('Gate Search Dark');
    await db.drizzle.db.update(game).set({ isActive: false }).where(eq(game.id, dark.row.id));
    const orphaned = await seedPlayableGame('Gate Search Orphaned');
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, orphaned.provider.id));

    const svc = makeLobbyService();
    expect((await svc.search('gate search')).map((r) => r.name)).toEqual(['Gate Search Live']);
  });

  it('getCategoryGames hides inactive games and games of deactivated providers', async () => {
    const tag = randomUUID();
    const [category] = await db.drizzle.db
      .insert(lobbyCategory)
      .values({ slug: `gate-${tag}`, name: 'Gate' })
      .returning();
    const live = await seedPlayableGame('Gate Feed Live');
    const dark = await seedPlayableGame('Gate Feed Dark');
    await db.drizzle.db.update(game).set({ isActive: false }).where(eq(game.id, dark.row.id));
    const orphaned = await seedPlayableGame('Gate Feed Orphaned');
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, orphaned.provider.id));
    await db.drizzle.db.insert(lobbyCategoryGame).values([
      { gameId: live.row.id, categoryId: category!.id, sortOrder: 0 },
      { gameId: dark.row.id, categoryId: category!.id, sortOrder: 1 },
      { gameId: orphaned.row.id, categoryId: category!.id, sortOrder: 2 },
    ]);
    const [visibleCategory, hiddenCategory] = await db.drizzle.db
      .insert(gameCategory)
      .values([
        { slug: `visible-${tag}`, name: 'Visible', isActive: true },
        { slug: `hidden-${tag}`, name: 'Hidden', isActive: false },
      ])
      .returning();
    await db.drizzle.db.insert(gameCategoryGame).values([
      { gameId: live.row.id, categoryId: visibleCategory!.id },
      { gameId: live.row.id, categoryId: hiddenCategory!.id },
    ]);

    const svc = makeLobbyService();
    const feed = await svc.getCategoryGames(category!.slug);
    expect(feed.games.map((g) => g.name)).toEqual(['Gate Feed Live']);
    expect(feed.games[0]?.categories.map((entry) => entry.name)).toEqual(['Visible']);

    const listed = await svc.listCategories();
    expect(listed.find((entry) => entry.slug === `gate-${tag}`)?.gameCount).toBe(feed.games.length);
  });

  it('carries category translations into the game feed', async () => {
    const tag = randomUUID();
    const [category] = await db.drizzle.db
      .insert(lobbyCategory)
      .values({ slug: `translated-${tag}`, name: 'Translated' })
      .returning();
    const live = await seedPlayableGame('Translated Feed Live');
    await db.drizzle.db
      .insert(lobbyCategoryGame)
      .values({ gameId: live.row.id, categoryId: category!.id, sortOrder: 0 });
    const [tagged] = await db.drizzle.db
      .insert(gameCategory)
      .values({
        slug: `tagged-${tag}`,
        name: 'Slots',
        isActive: true,
        translations: { de: { name: 'Spielautomaten' } },
      })
      .returning();
    await db.drizzle.db
      .insert(gameCategoryGame)
      .values({ gameId: live.row.id, categoryId: tagged!.id });

    const feed = await makeLobbyService().getCategoryGames(category!.slug);
    expect(feed.games[0]?.categories).toEqual([
      expect.objectContaining({ name: 'Slots', translations: { de: { name: 'Spielautomaten' } } }),
    ]);
  });

  it('getFeatured drops slots for inactive games and deactivated providers', async () => {
    const live = await seedPlayableGame('Featured Live');
    const dark = await seedPlayableGame('Featured Dark');
    await db.drizzle.db.update(game).set({ isActive: false }).where(eq(game.id, dark.row.id));
    const orphaned = await seedPlayableGame('Featured Orphaned');
    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(eq(gameProvider.id, orphaned.provider.id));
    await db.drizzle.db.insert(featuredSlot).values([
      { gameId: live.row.id, title: 'Live', placement: 'home', sortOrder: 0 },
      { gameId: dark.row.id, title: 'Dark', placement: 'home', sortOrder: 1 },
      { gameId: orphaned.row.id, title: 'Orphaned', placement: 'home', sortOrder: 2 },
    ]);

    const featured = await makeLobbyService().getFeatured();

    expect(featured).toHaveLength(1);
    expect(featured[0]).toMatchObject({ title: 'Live', gameId: live.row.id });
  });
});

describe('LobbyService layout cache', () => {
  it('invalidates the public layout cache when the aggregate is replaced', async () => {
    const catalog = createLobbySectionCatalog([
      {
        type: 'text',
        parseConfig: (config) => configSchema.parse(config),
        async resolve(sections) {
          return new Map(sections.map((section) => [section.id, section.config]));
        },
      },
    ]);
    const svc = new LobbyService(db.drizzle, makeEventBus(), catalog, new RedisCache(redis.client));
    await svc.replaceLayout({
      version: 0,
      sections: [{ type: 'text', config: { value: 'first' }, isEnabled: true }],
      ip: null,
      userAgent: null,
    });
    const first = await svc.getLayout();
    expect(first).toMatchObject([{ type: 'text', data: { value: 'first' } }]);
    expect(await redis.client.pTTL('cache:lobby:layout')).toBeGreaterThan(0);

    const admin = await svc.getAdminLayout();
    await svc.replaceLayout({
      version: admin.version,
      sections: [{ type: 'text', config: { value: 'second' }, isEnabled: true }],
      ip: null,
      userAgent: null,
    });
    expect(await svc.getLayout()).toMatchObject([{ type: 'text', data: { value: 'second' } }]);
  });
});
