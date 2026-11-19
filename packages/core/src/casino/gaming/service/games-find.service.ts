import { and, asc, count, eq, exists, ilike, inArray, sql } from 'drizzle-orm';
import { likeContains, type DrizzleService } from '@openora/core/server';
import {
  GAMES_FIND_MAX_CATEGORIES,
  GAME_CATEGORIES_MAX,
  type GameCategories,
  type GameCategoriesInput,
  type GamesFind,
  type GamesFindInput,
} from '../contract/index.js';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';

type GameCategoryRef = GamesFind['games'][number]['categories'][number];

/** The game catalog as an agent reads it: games and categories by id, for the back office to link. */
export class GamesFindService {
  constructor(private readonly drizzle: DrizzleService) {}

  async find({
    search,
    providerSlug,
    gameType,
    reviewStatus,
    active,
    gameCategoryId,
    limit,
  }: GamesFindInput): Promise<GamesFind> {
    const db = this.drizzle.db;
    const where = and(
      search ? ilike(game.name, likeContains(search)) : undefined,
      providerSlug ? eq(gameProvider.slug, providerSlug) : undefined,
      gameType ? eq(game.gameType, gameType) : undefined,
      reviewStatus?.length ? inArray(game.reviewStatus, reviewStatus) : undefined,
      active === undefined ? undefined : eq(game.isActive, active),
      gameCategoryId
        ? exists(
            db
              .select({ one: sql`1` })
              .from(gameCategoryGame)
              .where(
                and(
                  eq(gameCategoryGame.gameId, game.id),
                  eq(gameCategoryGame.categoryId, gameCategoryId),
                ),
              ),
          )
        : undefined,
    );
    const [rows, totals] = await Promise.all([
      db
        .select({
          gameId: game.id,
          name: game.name,
          slug: game.slug,
          provider: gameProvider.name,
          gameType: game.gameType,
          reviewStatus: game.reviewStatus,
          isActive: game.isActive,
          isUnavailable: game.isUnavailable,
        })
        .from(game)
        .innerJoin(gameProvider, eq(gameProvider.id, game.providerId))
        .where(where)
        .orderBy(asc(game.name), asc(game.id))
        .limit(limit + 1),
      db
        .select({ total: count() })
        .from(game)
        .innerJoin(gameProvider, eq(gameProvider.id, game.providerId))
        .where(where),
    ]);
    const page = rows.slice(0, limit);
    const categoriesOf = await this.categoriesOf(page.map((row) => row.gameId));
    return {
      total: totals[0]?.total ?? 0,
      truncated: rows.length > limit,
      games: page.map((row) => ({ ...row, categories: categoriesOf.get(row.gameId) ?? [] })),
    };
  }

  async categories({ active }: GameCategoriesInput): Promise<GameCategories> {
    const rows = await this.drizzle.db
      .select({
        gameCategoryId: gameCategory.id,
        slug: gameCategory.slug,
        name: gameCategory.name,
        isActive: gameCategory.isActive,
        membershipMode: gameCategory.membershipMode,
        sortOrder: gameCategory.sortOrder,
        gameCount: count(gameCategoryGame.id),
      })
      .from(gameCategory)
      .leftJoin(gameCategoryGame, eq(gameCategoryGame.categoryId, gameCategory.id))
      .where(active === undefined ? undefined : eq(gameCategory.isActive, active))
      .groupBy(gameCategory.id)
      .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name), asc(gameCategory.id))
      .limit(GAME_CATEGORIES_MAX + 1);
    return {
      categories: rows.slice(0, GAME_CATEGORIES_MAX),
      truncated: rows.length > GAME_CATEGORIES_MAX,
    };
  }

  /** The first categories of each game, in lobby order. */
  private async categoriesOf(gameIds: readonly string[]): Promise<Map<string, GameCategoryRef[]>> {
    if (gameIds.length === 0) {
      return new Map();
    }
    const rows = await this.drizzle.db
      .select({
        gameId: gameCategoryGame.gameId,
        gameCategoryId: gameCategory.id,
        name: gameCategory.name,
      })
      .from(gameCategoryGame)
      .innerJoin(gameCategory, eq(gameCategory.id, gameCategoryGame.categoryId))
      .where(inArray(gameCategoryGame.gameId, [...gameIds]))
      .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name), asc(gameCategory.id));
    const byGame = new Map<string, GameCategoryRef[]>();
    for (const { gameId, ...category } of rows) {
      const held = byGame.get(gameId) ?? [];
      if (held.length < GAMES_FIND_MAX_CATEGORIES) {
        byGame.set(gameId, [...held, category]);
      }
    }
    return byGame;
  }
}
