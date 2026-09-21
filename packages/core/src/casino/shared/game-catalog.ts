import { type SQL, and, asc, eq, inArray, sql } from 'drizzle-orm';
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

// The admin making a catalog change - carried into the emitted event for the audit trail.
export type CatalogActor = {
  actorId: User['id'];
} & ClientMeta;

// A game is player-visible only when the game itself and its provider are both
// active and the vendor has not marked the game unavailable. Single owner for the
// "playable" definition - the public list/search filters and the startRound gate
// must never drift apart.
export function playableGameCondition() {
  return and(
    eq(game.isActive, true),
    eq(game.isUnavailable, false),
    eq(gameProvider.isActive, true),
  );
}

export function countWhere(condition: SQL | undefined) {
  return sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
}

export type GameCategoryTriggerSnapshot = Pick<Game, 'name' | 'isActive' | 'providerId'> & {
  categoryIds: readonly GameCategory['id'][];
};

// The category ids whose rank could have moved because of a game write - the union of
// before/after membership, but only when the game's provider, name, active state, or category
// membership actually changed (a name/active change matters because a definition can
// order or filter on either, and an active flip also moves the playable/unplayable
// split pins are placed within). Shared by the gaming.game.updated event handler
// (plugin.ts, the fast path) and updateGame's own in-transaction dirty-marking
// (gaming.service.ts, the durable marker the sweep reads) - see docs/modules/gaming.md.
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

// Marks every category in `categoryIds` dirty for the rank sweep, inside the caller's
// own transaction - a no-op for an empty list. See docs/modules/gaming.md.
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

// The distinct categories any of `gameIds` currently belongs to - one query, no N+1.
// Shared by the durable dirty-marking below and plugin.ts's fast-path enqueue (a plain
// read there, not inside a transaction) - see docs/modules/gaming.md.
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

// The distinct categories containing any game of `providerIds` - one query, no N+1.
// Same sharing rationale as categoryIdsForGameIds above.
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

// Marks every category containing one of `gameIds` dirty, inside the caller's own
// transaction - a no-op when nothing matches. Returns the resolved category ids so a
// caller that also needs them (eg to carry on an emitted event) doesn't have to look
// them up a second time after commit. See docs/modules/gaming.md.
export async function markCategoriesRankDirtyForGames(
  tx: DrizzleTx,
  gameIds: readonly Game['id'][],
): Promise<string[]> {
  const categoryIds = await categoryIdsForGameIds(tx, gameIds);
  await markCategoriesRankDirty(tx, categoryIds);
  return categoryIds;
}

// Marks every category containing a game of `providerIds` dirty, inside the caller's
// own transaction - a no-op when nothing matches. Same return-the-ids rationale as
// markCategoriesRankDirtyForGames above.
export async function markCategoriesRankDirtyForProviders(
  tx: DrizzleTx,
  providerIds: readonly GameProvider['id'][],
): Promise<string[]> {
  const categoryIds = await categoryIdsForProviderIds(tx, providerIds);
  await markCategoriesRankDirty(tx, categoryIds);
  return categoryIds;
}

// The order every reader of a category's games uses: by the category's materialized
// `rank` (job-written, NULL until the first rank run), falling back to name for a game
// not yet ranked. Single owner - the public list-games route and GAME_CATALOG_READER
// must never drift apart in ordering. Plain `asc(rank)` relies on Postgres' own default
// (NULLS LAST for ASC) to put an unranked game after every ranked one - a leading
// `rank IS NULL` term is behaviourally identical but defeats the `(category_id, rank)`
// index, forcing a seq scan + sort of the whole category on every page.
export function categoryGameOrder() {
  return [asc(gameCategoryGame.rank), asc(game.name), asc(game.id)] as const;
}

export const providerSummaryColumns = {
  id: gameProvider.id,
  slug: gameProvider.slug,
  name: gameProvider.name,
  logoUrl: gameProvider.logoUrl,
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

export function isGamePlayable(
  target: Pick<Game, 'isActive' | 'isUnavailable'>,
  provider: Pick<GameProvider, 'isActive'>,
): boolean {
  return target.isActive === true && target.isUnavailable === false && provider.isActive === true;
}

// Groups batched join rows per owner id, keeping the query's row order in each list.
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

// One batched query for many games - never per-game lookups (no N+1).
// Shared by gaming and lobby so the join + ordering has a single owner.
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
