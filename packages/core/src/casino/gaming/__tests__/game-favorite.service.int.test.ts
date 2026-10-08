import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { game, gameFavorite, gameProvider } from '../schema/index.js';
import {
  GameFavoriteService,
  GameFavoriteLimitReachedError,
} from '../service/game-favorite.service.js';
import { GameNotFoundError } from '../service/gaming.service.js';
import { GAME_FAVORITE_LIMIT } from '../contract/index.js';

let db: TestDb;
let favorites: GameFavoriteService;

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

async function seedProvider(overrides: Partial<typeof gameProvider.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(gameProvider)
      .values({ slug: `provider-${randomUUID()}`, name: 'Provider', isActive: true, ...overrides })
      .returning(),
    new Error('seedProvider: query returned no row'),
  );
}

async function seedGame(providerId: string, overrides: Partial<typeof game.$inferInsert> = {}) {
  return findOneOrThrow(
    await db.drizzle.db
      .insert(game)
      .values({
        reviewStatus: 'approved',
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
}

async function favoriteIds(userId: string) {
  return favorites.listFavoriteIds(userId);
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  favorites = new GameFavoriteService(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${gameFavorite}, ${game}, ${gameProvider} RESTART IDENTITY CASCADE`,
  );
});

describe('GameFavoriteService.addFavorite', () => {
  it('rejects an unknown game id', async () => {
    const userId = randomUUID();
    await expect(favorites.addFavorite(userId, UNKNOWN_ID)).rejects.toBeInstanceOf(
      GameNotFoundError,
    );
  });

  it('is idempotent: favoriting the same game twice keeps one row', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const userId = randomUUID();

    await expect(favorites.addFavorite(userId, target.id)).resolves.toEqual({ success: true });
    await expect(favorites.addFavorite(userId, target.id)).resolves.toEqual({ success: true });

    const rows = await db.drizzle.db
      .select()
      .from(gameFavorite)
      .where(sql`${gameFavorite.userId} = ${userId}`);
    expect(rows).toHaveLength(1);
  });

  it('allows two different players to favorite the same game independently', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const playerA = randomUUID();
    const playerB = randomUUID();

    await favorites.addFavorite(playerA, target.id);
    await favorites.addFavorite(playerB, target.id);

    expect(await favoriteIds(playerA)).toEqual([target.id]);
    expect(await favoriteIds(playerB)).toEqual([target.id]);
  });

  it(`rejects a ${GAME_FAVORITE_LIMIT + 1}th favorite with a typed cap error`, async () => {
    const provider = await seedProvider();
    const userId = randomUUID();
    const games = await Promise.all(
      Array.from({ length: GAME_FAVORITE_LIMIT }, () => seedGame(provider.id)),
    );
    await db.drizzle.db.insert(gameFavorite).values(games.map((g) => ({ userId, gameId: g.id })));

    const overflow = await seedGame(provider.id);
    await expect(favorites.addFavorite(userId, overflow.id)).rejects.toBeInstanceOf(
      GameFavoriteLimitReachedError,
    );

    const total = await db.drizzle.db
      .select()
      .from(gameFavorite)
      .where(sql`${gameFavorite.userId} = ${userId}`);
    expect(total).toHaveLength(GAME_FAVORITE_LIMIT);
  });

  it('re-favoriting an already-favorited game at the cap is still a no-op success', async () => {
    const provider = await seedProvider();
    const userId = randomUUID();
    const games = await Promise.all(
      Array.from({ length: GAME_FAVORITE_LIMIT }, () => seedGame(provider.id)),
    );
    await db.drizzle.db.insert(gameFavorite).values(games.map((g) => ({ userId, gameId: g.id })));

    const alreadyFavorited = games[0];
    if (!alreadyFavorited) {
      throw new Error('expected at least one seeded game');
    }
    await expect(favorites.addFavorite(userId, alreadyFavorited.id)).resolves.toEqual({
      success: true,
    });
  });
});

describe('GameFavoriteService.removeFavorite', () => {
  it('is idempotent: removing a favorite that was never set still succeeds', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const userId = randomUUID();

    await expect(favorites.removeFavorite(userId, target.id)).resolves.toEqual({ success: true });
  });

  it("only removes the calling player's own row", async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const playerA = randomUUID();
    const playerB = randomUUID();
    await favorites.addFavorite(playerA, target.id);
    await favorites.addFavorite(playerB, target.id);

    await favorites.removeFavorite(playerA, target.id);

    expect(await favoriteIds(playerA)).toEqual([]);
    expect(await favoriteIds(playerB)).toEqual([target.id]);
  });
});

describe('GameFavoriteService.listFavorites', () => {
  it('orders newest-favorited first', async () => {
    const provider = await seedProvider();
    const first = await seedGame(provider.id, { name: 'First' });
    const second = await seedGame(provider.id, { name: 'Second' });
    const userId = randomUUID();

    await favorites.addFavorite(userId, first.id);
    await favorites.addFavorite(userId, second.id);

    const list = await favorites.listFavorites(userId);
    expect(list.map((g) => g.id)).toEqual([second.id, first.id]);
  });

  it('hides a favorite whose game was disabled but keeps the favorite row', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const userId = randomUUID();
    await favorites.addFavorite(userId, target.id);

    await db.drizzle.db
      .update(game)
      .set({ isActive: false })
      .where(sql`${game.id} = ${target.id}`);

    expect(await favorites.listFavorites(userId)).toEqual([]);
    expect(await favoriteIds(userId)).toEqual([target.id]);

    await db.drizzle.db
      .update(game)
      .set({ isActive: true })
      .where(sql`${game.id} = ${target.id}`);

    expect((await favorites.listFavorites(userId)).map((g) => g.id)).toEqual([target.id]);
  });

  it('hides a favorite whose provider was disabled but keeps the favorite row', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const userId = randomUUID();
    await favorites.addFavorite(userId, target.id);

    await db.drizzle.db
      .update(gameProvider)
      .set({ isActive: false })
      .where(sql`${gameProvider.id} = ${provider.id}`);

    expect(await favorites.listFavorites(userId)).toEqual([]);
    expect(await favoriteIds(userId)).toEqual([target.id]);
  });

  it("never returns another player's favorites", async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const playerA = randomUUID();
    const playerB = randomUUID();
    await favorites.addFavorite(playerA, target.id);

    expect(await favorites.listFavorites(playerB)).toEqual([]);
    expect(await favoriteIds(playerB)).toEqual([]);
  });

  it('removes the favorite when its game is deleted (FK cascade)', async () => {
    const provider = await seedProvider();
    const target = await seedGame(provider.id);
    const userId = randomUUID();
    await favorites.addFavorite(userId, target.id);

    await db.drizzle.db.delete(game).where(sql`${game.id} = ${target.id}`);

    expect(await favoriteIds(userId)).toEqual([]);
    const rows = await db.drizzle.db
      .select()
      .from(gameFavorite)
      .where(sql`${gameFavorite.userId} = ${userId}`);
    expect(rows).toHaveLength(0);
  });
});
