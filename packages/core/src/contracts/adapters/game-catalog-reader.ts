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
  listPlayableGamesInCategory(
    categoryId: GameCategorySummary['id'],
    opts: { limit: number },
  ): Promise<CatalogGame[]>;
  getActiveCategories(
    categoryIds: GameCategorySummary['id'][],
    opts?: { withGameCount?: boolean },
  ): Promise<
    Map<
      GameCategorySummary['id'],
      GameCategorySummaryWithTranslations | CatalogCategoryWithGameCount
    >
  >;
  getCategoryIdsByGame(
    gameIds: CatalogGame['id'][],
  ): Promise<Map<CatalogGame['id'], Set<GameCategorySummary['id']>>>;
  listActiveCategoriesWithGameCount(
    opts: PageQuery,
  ): Promise<Paginated<CatalogCategoryWithGameCount>>;
  getActiveProviders(
    providerIds: GameProviderSummary['id'][],
  ): Promise<Map<GameProviderSummary['id'], GameProviderSummary>>;
  listActiveProviders(opts: PageQuery): Promise<Paginated<GameProviderSummary>>;
};

export const GAME_CATALOG_READER: Token<GameCatalogReader> = createToken('GAME_CATALOG_READER');
