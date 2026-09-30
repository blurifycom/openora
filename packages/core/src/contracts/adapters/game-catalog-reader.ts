/**
 * Read-only view of the casino catalog for code outside the gaming module (overlay lobby
 * sections, promotions), so it never re-implements the playability rule over the gaming tables.
 * "Playable" means the game and its provider are both active and the vendor has not marked the
 * game unavailable. Every method is batched; an id that is unknown, unplayable, inactive or not
 * a UUID is simply absent from the result, and a map keyed by the given ids iterates in the
 * order those ids were passed.
 */
import { createToken, type Token } from './token.js';
import type { PageQuery, Paginated } from '../kit.js';
import type {
  GameCategorySummary,
  GameCategorySummaryWithTranslations,
  GameProviderSummary,
  GameTagSummary,
} from '../schemas/game.js';

export type CatalogGame = {
  id: string;
  name: string;
  slug: string;
  provider: GameProviderSummary;
  thumbnailUrl: string | null;
  customThumbnailUrl: string | null;
  tags: GameTagSummary[];
};

export type CatalogCategoryWithGameCount = GameCategorySummaryWithTranslations & {
  gameCount: number;
};

export type GameCatalogReader = {
  getPlayableGames(gameIds: CatalogGame['id'][]): Promise<Map<CatalogGame['id'], CatalogGame>>;
  /**
   * Ordered by the category's configured sort; games not yet ranked come last, by name.
   * Empty when the category is inactive or `limit` is below 1.
   */
  listPlayableGamesInCategory(
    categoryId: GameCategorySummary['id'],
    opts: { limit: number },
  ): Promise<CatalogGame[]>;
  /** `gameCount` is present only with `withGameCount: true` and counts playable games only, so it can be 0. */
  getActiveCategories(
    categoryIds: GameCategorySummary['id'][],
    opts?: { withGameCount?: boolean },
  ): Promise<
    Map<
      GameCategorySummary['id'],
      GameCategorySummaryWithTranslations | CatalogCategoryWithGameCount
    >
  >;
  /** Active category ids per game, whatever the game's own playability. A game in no active category is absent. */
  getCategoryIdsByGame(
    gameIds: CatalogGame['id'][],
  ): Promise<Map<CatalogGame['id'], Set<GameCategorySummary['id']>>>;
  /** Ordered by sortOrder then name; `gameCount` counts playable games only, so it can be 0. */
  listActiveCategoriesWithGameCount(
    opts: PageQuery,
  ): Promise<Paginated<CatalogCategoryWithGameCount>>;
  getActiveProviders(
    providerIds: GameProviderSummary['id'][],
  ): Promise<Map<GameProviderSummary['id'], GameProviderSummary>>;
  /** Ordered by name. */
  listActiveProviders(opts: PageQuery): Promise<Paginated<GameProviderSummary>>;
};

export const GAME_CATALOG_READER: Token<GameCatalogReader> = createToken('GAME_CATALOG_READER');
