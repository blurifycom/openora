import { DrizzleService, pageToOffset, type DrizzleDb } from '@openora/core/server';
import {
  UuidSchema,
  type CatalogCategoryWithGameCount,
  type CatalogGame,
  type GameCatalogReader,
  type GameCategorySummary,
  type GameProviderSummary,
  type PageQuery,
} from '@openora/core/contracts';
import { type SQL, and, asc, count, eq, inArray } from 'drizzle-orm';
import { game, gameCategory, gameCategoryGame, gameProvider } from '../schema/index.js';
import {
  categorySummaryColumns,
  countWhere,
  groupRows,
  playableGameCondition,
  providerSummaryColumns,
  tagsByGameIds,
  toGameTagSummary,
} from '../../shared/game-catalog.js';

const catalogGameColumns = {
  id: game.id,
  name: game.name,
  slug: game.slug,
  provider: providerSummaryColumns,
  thumbnailUrl: game.thumbnailUrl,
};

function isUuid(id: string) {
  return UuidSchema.safeParse(id).success;
}

// Guards the offset: Postgres rejects a negative OFFSET, and a plugin calls the port
// directly, with no PageQuerySchema in front of it.
function isValidPage(page: number, limit: number) {
  return page >= 1 && limit >= 1;
}

function distinctUuids(ids: readonly string[]) {
  return [...new Set(ids)].filter(isUuid);
}

function inIdOrder<Value>(ids: readonly string[], valuesById: ReadonlyMap<string, Value>) {
  return new Map(
    ids.flatMap((id) => {
      const value = valuesById.get(id);
      return value === undefined ? [] : [[id, value] as const];
    }),
  );
}

function mapInIdOrder<Row extends { id: string }>(ids: readonly string[], rows: Row[]) {
  return inIdOrder(ids, new Map(rows.map((row) => [row.id, row])));
}

type CatalogGameRow = Omit<CatalogGame, 'tags'>;

async function withTags(db: DrizzleDb, rows: CatalogGameRow[]): Promise<CatalogGame[]> {
  const tags = await tagsByGameIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, tags: (tags.get(row.id) ?? []).map(toGameTagSummary) }));
}

function selectActiveCategoriesWithGameCount(db: DrizzleDb, where?: SQL) {
  return db
    .select({ ...categorySummaryColumns, gameCount: countWhere(playableGameCondition()) })
    .from(gameCategory)
    .leftJoin(gameCategoryGame, eq(gameCategoryGame.categoryId, gameCategory.id))
    .leftJoin(game, eq(gameCategoryGame.gameId, game.id))
    .leftJoin(gameProvider, eq(game.providerId, gameProvider.id))
    .where(and(eq(gameCategory.isActive, true), where))
    .groupBy(gameCategory.id);
}

export class GameCatalogReaderService implements GameCatalogReader {
  constructor(private readonly drizzle: DrizzleService) {}

  async getPlayableGames(gameIds: CatalogGame['id'][]) {
    const ids = distinctUuids(gameIds);
    if (ids.length === 0) {
      return new Map<CatalogGame['id'], CatalogGame>();
    }
    const rows = await this.drizzle.db
      .select(catalogGameColumns)
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
      .where(and(inArray(game.id, ids), playableGameCondition()));
    return mapInIdOrder(ids, await withTags(this.drizzle.db, rows));
  }

  async listPlayableGamesInCategory(
    categoryId: GameCategorySummary['id'],
    { limit }: { limit: number },
  ) {
    if (!isUuid(categoryId) || limit < 1) {
      return [];
    }
    const rows = await this.drizzle.db
      .select(catalogGameColumns)
      .from(game)
      .innerJoin(gameProvider, eq(game.providerId, gameProvider.id))
      .innerJoin(gameCategoryGame, eq(gameCategoryGame.gameId, game.id))
      .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
      .where(
        and(
          eq(gameCategoryGame.categoryId, categoryId),
          eq(gameCategory.isActive, true),
          playableGameCondition(),
        ),
      )
      .orderBy(asc(game.name), asc(game.id))
      .limit(limit);
    return withTags(this.drizzle.db, rows);
  }

  async getActiveCategories(
    categoryIds: GameCategorySummary['id'][],
    { withGameCount = false }: { withGameCount?: boolean } = {},
  ) {
    const ids = distinctUuids(categoryIds);
    if (ids.length === 0) {
      return new Map<GameCategorySummary['id'], CatalogCategoryWithGameCount>();
    }
    const inIds = inArray(gameCategory.id, ids);
    if (withGameCount) {
      return mapInIdOrder(ids, await selectActiveCategoriesWithGameCount(this.drizzle.db, inIds));
    }
    const rows = await this.drizzle.db
      .select(categorySummaryColumns)
      .from(gameCategory)
      .where(and(inIds, eq(gameCategory.isActive, true)));
    return mapInIdOrder(ids, rows);
  }

  async getActiveProviders(providerIds: GameProviderSummary['id'][]) {
    const ids = distinctUuids(providerIds);
    if (ids.length === 0) {
      return new Map<GameProviderSummary['id'], GameProviderSummary>();
    }
    const rows = await this.drizzle.db
      .select(providerSummaryColumns)
      .from(gameProvider)
      .where(and(inArray(gameProvider.id, ids), eq(gameProvider.isActive, true)));
    return mapInIdOrder(ids, rows);
  }

  async getCategoryIdsByGame(gameIds: CatalogGame['id'][]) {
    const ids = distinctUuids(gameIds);
    if (ids.length === 0) {
      return new Map<CatalogGame['id'], Set<GameCategorySummary['id']>>();
    }
    const rows = await this.drizzle.db
      .select({ gameId: gameCategoryGame.gameId, categoryId: gameCategoryGame.categoryId })
      .from(gameCategoryGame)
      .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
      .where(and(inArray(gameCategoryGame.gameId, ids), eq(gameCategory.isActive, true)));
    const categoryIdsByGame = groupRows(
      rows,
      (row) => row.gameId,
      (row) => row.categoryId,
    );
    return inIdOrder(
      ids,
      new Map(
        [...categoryIdsByGame].map(([gameId, categoryIds]) => [gameId, new Set(categoryIds)]),
      ),
    );
  }

  async listActiveCategoriesWithGameCount({ page, limit }: PageQuery) {
    const isActive = eq(gameCategory.isActive, true);
    const [items, [{ n }]] = await Promise.all([
      isValidPage(page, limit)
        ? selectActiveCategoriesWithGameCount(this.drizzle.db)
            .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name), asc(gameCategory.slug))
            .limit(limit)
            .offset(pageToOffset(page, limit))
        : [],
      this.drizzle.db.select({ n: count() }).from(gameCategory).where(isActive),
    ]);
    return { items, total: Number(n), page, limit };
  }

  async listActiveProviders({ page, limit }: PageQuery) {
    const isActive = eq(gameProvider.isActive, true);
    const [items, [{ n }]] = await Promise.all([
      isValidPage(page, limit)
        ? this.drizzle.db
            .select(providerSummaryColumns)
            .from(gameProvider)
            .where(isActive)
            .orderBy(asc(gameProvider.name), asc(gameProvider.slug))
            .limit(limit)
            .offset(pageToOffset(page, limit))
        : [],
      this.drizzle.db.select({ n: count() }).from(gameProvider).where(isActive),
    ]);
    return { items, total: Number(n), page, limit };
  }
}
