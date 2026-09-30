import { and, count, desc, eq, ne } from 'drizzle-orm';
import { createDomainError, DrizzleService, withAdvisoryXactLock } from '@openora/core/server';
import type { User } from '@openora/core/contracts';
import { game, gameFavorite, gameProvider, type Game } from '../schema/index.js';
import {
  categoriesByGameIds,
  playableGameCondition,
  tagsByGameIds,
  toGame,
} from '../../shared/game-catalog.js';
import { GameNotFoundError } from './gaming.service.js';
import { GAME_FAVORITE_LIMIT } from '../contract/index.js';

export const GameFavoriteLimitReachedError = createDomainError<[limit: number]>(
  'GameFavoriteLimitReachedError',
  (limit) => `A player may favorite at most ${limit} games`,
);

function favoriteCapLockKey(userId: User['id']) {
  return `game-favorite-cap:${userId}`;
}

export class GameFavoriteService {
  constructor(private readonly drizzle: DrizzleService) {}

  async listFavorites(userId: User['id']) {
    const rows = await this.drizzle.db
      .select({ game, provider: gameProvider })
      .from(gameFavorite)
      .innerJoin(game, eq(gameFavorite.gameId, game.id))
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
      .where(and(eq(gameFavorite.userId, userId), playableGameCondition()))
      .orderBy(desc(gameFavorite.createdAt), desc(gameFavorite.id));
    const gameIds = rows.map((r) => r.game.id);
    const [categories, tags] = await Promise.all([
      categoriesByGameIds(this.drizzle.db, gameIds, true),
      tagsByGameIds(this.drizzle.db, gameIds),
    ]);
    return rows.map((r) =>
      toGame({
        ...r,
        categories: categories.get(r.game.id) ?? [],
        tags: tags.get(r.game.id) ?? [],
      }),
    );
  }

  // Unlike listFavorites, includes hidden games - a hidden favorite must still heart itself.
  async listFavoriteIds(userId: User['id']): Promise<Game['id'][]> {
    const rows = await this.drizzle.db
      .select({ gameId: gameFavorite.gameId })
      .from(gameFavorite)
      .where(eq(gameFavorite.userId, userId))
      .orderBy(desc(gameFavorite.createdAt), desc(gameFavorite.id));
    return rows.map((r) => r.gameId);
  }

  async addFavorite(userId: User['id'], gameId: Game['id']) {
    const [playableGame] = await this.drizzle.db
      .select({ id: game.id })
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
      .where(and(eq(game.id, gameId), playableGameCondition()))
      .limit(1);
    if (!playableGame) {
      throw new GameNotFoundError(gameId);
    }

    await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, favoriteCapLockKey(userId), async () => {
        const [{ total }] = await tx
          .select({ total: count() })
          .from(gameFavorite)
          .where(and(eq(gameFavorite.userId, userId), ne(gameFavorite.gameId, gameId)));
        if (Number(total) >= GAME_FAVORITE_LIMIT) {
          throw new GameFavoriteLimitReachedError(GAME_FAVORITE_LIMIT);
        }
        // ne() above excludes this gameId, so re-favoriting never counts as a cap hit.
        await tx.insert(gameFavorite).values({ userId, gameId }).onConflictDoNothing();
      }),
    );
    return { success: true } as const;
  }

  async removeFavorite(userId: User['id'], gameId: Game['id']) {
    await this.drizzle.db
      .delete(gameFavorite)
      .where(and(eq(gameFavorite.userId, userId), eq(gameFavorite.gameId, gameId)));
    return { success: true } as const;
  }
}
