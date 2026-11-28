import { type SQL, and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { ClientMeta, GameProviderAggregatorMapping, User } from '@openora/core/contracts';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';
import {
  game,
  gameCategory,
  gameCategoryGame,
  gameTag,
  gameTagGame,
  gameProvider,
  gameProviderAggregatorMapping,
  type Game,
  type GameCategory,
  type GameTag,
  type GameProvider,
} from '@openora/core/casino/schema/gaming';

export type CatalogActor = {
  actorId: User['id'];
} & ClientMeta;

export function playableGameCondition() {
  return and(
    eq(game.isActive, true),
    eq(game.isUnavailable, false),
    eq(gameProvider.isActive, true),
  );
}

export function pendingReviewCondition() {
  return and(eq(game.reviewStatus, 'pending'), eq(game.isUnavailable, false));
}

export function isUnreviewed(status: Game['reviewStatus']): status is 'pending' | 'declined' {
  return status === 'pending' || status === 'declined';
}

export async function pendingReviewCountsByProviderIds(
  db: DrizzleDb | DrizzleTx,
  providerIds: GameProvider['id'][],
) {
  if (providerIds.length === 0) {
    return new Map<GameProvider['id'], number>();
  }
  const rows = await db
    .select({ providerId: game.providerId, n: count() })
    .from(game)
    .where(and(inArray(game.providerId, providerIds), pendingReviewCondition()))
    .groupBy(game.providerId);
  return new Map(rows.map((row) => [row.providerId, Number(row.n)]));
}

export function countWhere(condition: SQL | undefined) {
  return sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
}

export type GameCategoryTriggerSnapshot = Pick<Game, 'name' | 'isActive' | 'providerId'> & {
  categoryIds: readonly GameCategory['id'][];
};

export function categoryRankTriggerIds(
  before: GameCategoryTriggerSnapshot,
  after: GameCategoryTriggerSnapshot,
): string[] {
  const beforeCategoryIds = new Set(before.categoryIds);
  const afterCategoryIds = new Set(after.categoryIds);
  const membershipChanged =
    before.categoryIds.length !== after.categoryIds.length ||
    before.categoryIds.some((id) => !afterCategoryIds.has(id)) ||
    after.categoryIds.some((id) => !beforeCategoryIds.has(id));
  if (
    before.name === after.name &&
    before.isActive === after.isActive &&
    before.providerId === after.providerId &&
    !membershipChanged
  ) {
    return [];
  }
  return [...new Set([...before.categoryIds, ...after.categoryIds])];
}

export function rankDirtyPatch() {
  return {
    rankSeq: sql`${gameCategory.rankSeq} + 1`,
    rankDirtyAt: sql`greatest(clock_timestamp(), ${gameCategory.rankedAt} + interval '1 microsecond')`,
  };
}

export function isRankDirty(): SQL {
  return sql`${gameCategory.rankDirtyAt} IS NOT NULL AND (${gameCategory.rankedAt} IS NULL OR ${gameCategory.rankedAt} < ${gameCategory.rankDirtyAt})`;
}

export async function markCategoriesRankDirty(
  tx: DrizzleTx,
  categoryIds: readonly GameCategory['id'][],
) {
  if (categoryIds.length === 0) {
    return;
  }
  await tx
    .update(gameCategory)
    .set(rankDirtyPatch())
    .where(inArray(gameCategory.id, [...categoryIds]));
}

export async function categoryIdsForGameIds(
  db: DrizzleDb | DrizzleTx,
  gameIds: readonly Game['id'][],
): Promise<string[]> {
  if (gameIds.length === 0) {
    return [];
  }
  const rows = await db
    .selectDistinct({ categoryId: gameCategoryGame.categoryId })
    .from(gameCategoryGame)
    .where(inArray(gameCategoryGame.gameId, [...gameIds]));
  return rows.map((row) => row.categoryId);
}

export async function categoryIdsForProviderIds(
  db: DrizzleDb | DrizzleTx,
  providerIds: readonly GameProvider['id'][],
): Promise<string[]> {
  if (providerIds.length === 0) {
    return [];
  }
  const rows = await db
    .selectDistinct({ categoryId: gameCategoryGame.categoryId })
    .from(gameCategoryGame)
    .innerJoin(game, eq(gameCategoryGame.gameId, game.id))
    .where(inArray(game.providerId, [...providerIds]));
  return rows.map((row) => row.categoryId);
}

export async function markCategoriesRankDirtyForGames(
  tx: DrizzleTx,
  gameIds: readonly Game['id'][],
): Promise<string[]> {
  const categoryIds = await categoryIdsForGameIds(tx, gameIds);
  await markCategoriesRankDirty(tx, categoryIds);
  return categoryIds;
}

export async function markCategoriesRankDirtyForProviders(
  tx: DrizzleTx,
  providerIds: readonly GameProvider['id'][],
): Promise<string[]> {
  const categoryIds = await categoryIdsForProviderIds(tx, providerIds);
  await markCategoriesRankDirty(tx, categoryIds);
  return categoryIds;
}

export function categoryGameOrder() {
  return [asc(gameCategoryGame.rank), asc(game.name), asc(game.id)] as const;
}

export const providerSummaryColumns = {
  id: gameProvider.id,
  slug: gameProvider.slug,
  name: gameProvider.name,
  logoUrl: gameProvider.logoUrl,
  customLogoUrl: gameProvider.customLogoUrl,
};

export const categorySummaryColumns = {
  id: gameCategory.id,
  slug: gameCategory.slug,
  name: gameCategory.name,
  translations: gameCategory.translations,
  icon: gameCategory.icon,
  sortOrder: gameCategory.sortOrder,
};

export function toCategorySummary(record: GameCategory) {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    translations: record.translations ?? {},
    icon: record.icon,
    sortOrder: record.sortOrder,
  };
}

export function toGameTagSummary(record: GameTag) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    visibility: record.visibility,
    metadata: record.metadata,
  };
}

export function toGame(row: {
  game: Game;
  provider: GameProvider;
  categories: GameCategory[];
  tags: GameTag[];
}) {
  return {
    id: row.game.id,
    name: row.game.name,
    slug: row.game.slug,
    provider: {
      id: row.provider.id,
      slug: row.provider.slug,
      name: row.provider.name,
      logoUrl: row.provider.logoUrl,
      customLogoUrl: row.provider.customLogoUrl,
    },
    aggregator: row.game.aggregator,
    categories: row.categories.map(toCategorySummary),
    tags: row.tags.map(toGameTagSummary),
    gameType: row.game.gameType,
    thumbnailUrl: row.game.thumbnailUrl,
    customThumbnailUrl: row.game.customThumbnailUrl,
    isActive: row.game.isActive,
    isUnavailable: row.game.isUnavailable,
    metadata: row.game.metadata,
  };
}

export function toAdminGame(row: Parameters<typeof toGame>[0]) {
  return {
    ...toGame(row),
    reviewStatus: row.game.reviewStatus,
    reviewedAt: row.game.reviewedAt?.toISOString() ?? null,
    createdAt: row.game.createdAt.toISOString(),
  };
}

export function isGamePlayable(
  target: Pick<Game, 'isActive' | 'isUnavailable'>,
  provider: Pick<GameProvider, 'isActive'>,
): boolean {
  return target.isActive === true && target.isUnavailable === false && provider.isActive === true;
}

export function groupRows<Row, Key, Value>(
  rows: Row[],
  keyOf: (row: Row) => Key,
  valueOf: (row: Row) => Value,
) {
  const grouped = new Map<Key, Value[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = grouped.get(key);
    if (list) {
      list.push(valueOf(row));
    } else {
      grouped.set(key, [valueOf(row)]);
    }
  }
  return grouped;
}

export async function categoriesByGameIds(
  db: DrizzleDb,
  gameIds: Game['id'][],
  activeOnly = false,
) {
  if (gameIds.length === 0) {
    return new Map<Game['id'], GameCategory[]>();
  }
  const rows = await db
    .select({ gameId: gameCategoryGame.gameId, category: gameCategory })
    .from(gameCategoryGame)
    .innerJoin(gameCategory, eq(gameCategoryGame.categoryId, gameCategory.id))
    .where(
      and(
        inArray(gameCategoryGame.gameId, gameIds),
        activeOnly ? eq(gameCategory.isActive, true) : undefined,
      ),
    )
    .orderBy(asc(gameCategory.sortOrder), asc(gameCategory.name));
  return groupRows(
    rows,
    (r) => r.gameId,
    (r) => r.category,
  );
}

export async function mappingsByProviderIds(
  db: DrizzleDb | DrizzleTx,
  providerIds: GameProvider['id'][],
) {
  if (providerIds.length === 0) {
    return new Map<GameProvider['id'], GameProviderAggregatorMapping[]>();
  }
  const rows = await db
    .select({
      providerId: gameProviderAggregatorMapping.providerId,
      aggregator: gameProviderAggregatorMapping.aggregator,
      vendorId: gameProviderAggregatorMapping.vendorId,
    })
    .from(gameProviderAggregatorMapping)
    .where(inArray(gameProviderAggregatorMapping.providerId, providerIds))
    .orderBy(
      asc(gameProviderAggregatorMapping.providerId),
      asc(gameProviderAggregatorMapping.aggregator),
      asc(gameProviderAggregatorMapping.vendorId),
    );
  return groupRows(
    rows,
    (r) => r.providerId,
    ({ providerId: _providerId, ...mapping }): GameProviderAggregatorMapping => mapping,
  );
}

export async function tagsByGameIds(
  db: DrizzleDb,
  gameIds: Game['id'][],
  { includeInvisible = false }: { includeInvisible?: boolean } = {},
) {
  if (gameIds.length === 0) {
    return new Map<Game['id'], GameTag[]>();
  }
  const rows = await db
    .select({ gameId: gameTagGame.gameId, tag: gameTag })
    .from(gameTagGame)
    .innerJoin(gameTag, eq(gameTagGame.tagId, gameTag.id))
    .where(
      and(
        inArray(gameTagGame.gameId, gameIds),
        includeInvisible ? undefined : eq(gameTag.visibility, 'visible'),
      ),
    )
    .orderBy(asc(gameTag.name), asc(gameTag.id));
  return groupRows(
    rows,
    (r) => r.gameId,
    (r) => r.tag,
  );
}
