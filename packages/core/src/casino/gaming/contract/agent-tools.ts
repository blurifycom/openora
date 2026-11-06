import * as z from 'zod';
import {
  CurrencyTickerSchema,
  FIND_TOOL_MAX_LIMIT,
  FindToolLimitSchema,
  GAME_REVIEW_STATUSES,
  GameCategoryMembershipModeSchema,
  GameReviewStatusSchema,
  GameTypeSchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
  UuidSchema,
  checkDayRange,
  defineMcpTool,
  resolveDayRange,
  type DayRangeInput,
} from '@openora/core/contracts';

const TOP_GAMES_DEFAULT_DAYS = 30;
export const TOP_GAMES_MAX_DAYS = 92;
export const TOP_GAMES_MAX_LIMIT = 50;
export const TOP_GAMES_MAX_CURRENCIES = 20;

export const TOP_GAMES_SORT_FIELDS = [
  'volume',
  'revenue',
  'roundsPlayed',
  'uniquePlayers',
] as const;
export const TopGamesSortBySchema = z.enum(TOP_GAMES_SORT_FIELDS);
export type TopGamesSortBy = z.infer<typeof TopGamesSortBySchema>;

/** gaming.top_games's days: `dateTo` defaults to the day of `now`, `dateFrom` to 30 days ending on it. */
export function resolveTopGamesRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, TOP_GAMES_DEFAULT_DAYS, now);
}

export const TopGamesInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    gameType: GameTypeSchema.optional(),
    sortBy: TopGamesSortBySchema.default('volume'),
    sortDir: z.enum(['desc', 'asc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(TOP_GAMES_MAX_LIMIT).default(10),
  })
  .superRefine((input, ctx) => checkDayRange(resolveTopGamesRange(input), TOP_GAMES_MAX_DAYS, ctx));
export type TopGamesInput = z.infer<typeof TopGamesInputSchema>;

const GameFiguresSchema = z.object({
  volume: MoneyAmountSchema,
  revenue: SignedMoneyAmountSchema,
  roundsPlayed: z.number().int().nonnegative(),
  uniquePlayers: z.number().int().nonnegative(),
});

export const TopGamesOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  sortBy: TopGamesSortBySchema,
  sortDir: z.enum(['desc', 'asc']),
  currencies: z
    .array(
      z.object({
        currency: CurrencyTickerSchema,
        totals: GameFiguresSchema.extend({ gamesPlayed: z.number().int().nonnegative() }),
        games: z
          .array(
            GameFiguresSchema.extend({
              gameId: UuidSchema,
              name: z.string(),
              provider: z.string(),
              gameType: GameTypeSchema,
            }),
          )
          .max(TOP_GAMES_MAX_LIMIT),
      }),
    )
    .max(TOP_GAMES_MAX_CURRENCIES),
  truncated: z.boolean(),
});
export type TopGames = z.infer<typeof TopGamesOutputSchema>;

export const topGamesTool = defineMcpTool({
  id: 'gaming.top_games',
  title: 'Top games',
  description:
    'The games ranked by their completed rounds over whole UTC days from dateFrom through dateTo ' +
    '(defaults to the 30 days ending today; a range spans at most 92 days), separately per ' +
    'currency: volume (stakes net of reversed stakes), revenue (GGR: stakes minus wins, can be ' +
    'negative), rounds played and distinct players, as on the back office game performance ' +
    'report. sortBy picks the figure (volume by default) and sortDir the order, so sortBy ' +
    'revenue with sortDir asc lists the games that lost the operator the most. Each currency ' +
    'lists at most limit games (1 to 50, default 10) with its totals over every game played; a ' +
    'game with no completed round in range is not listed. Narrow with currency or gameType. At ' +
    'most 20 currencies, alphabetical; truncated is true when more had rounds. Amounts are ' +
    'decimal strings in the row currency and are never summed across currencies. Names no player.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'report', action: 'view' },
  inputSchema: TopGamesInputSchema,
  outputSchema: TopGamesOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'sortBy', 'sortDir', 'currencies', 'truncated'] },
  errors: [],
});

/** At most this many of a game's categories games.find lists with it. */
export const GAMES_FIND_MAX_CATEGORIES = 10;

export const GamesFindInputSchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  providerSlug: z.string().min(1).max(100).optional(),
  gameType: GameTypeSchema.optional(),
  reviewStatus: z.array(GameReviewStatusSchema).max(GAME_REVIEW_STATUSES.length).optional(),
  active: z.boolean().optional(),
  gameCategoryId: UuidSchema.optional(),
  limit: FindToolLimitSchema,
});
export type GamesFindInput = z.infer<typeof GamesFindInputSchema>;

export const GamesFindOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  games: z
    .array(
      z.object({
        gameId: UuidSchema,
        name: z.string(),
        slug: z.string(),
        provider: z.string(),
        gameType: GameTypeSchema,
        reviewStatus: GameReviewStatusSchema,
        isActive: z.boolean(),
        isUnavailable: z.boolean(),
        categories: z
          .array(z.object({ gameCategoryId: UuidSchema, name: z.string() }))
          .max(GAMES_FIND_MAX_CATEGORIES),
      }),
    )
    .max(FIND_TOOL_MAX_LIMIT),
});
export type GamesFind = z.infer<typeof GamesFindOutputSchema>;

export const gamesFindTool = defineMcpTool({
  id: 'games.find',
  title: 'Find games',
  description:
    'Lists the catalog games matching every filter given, by name (alphabetical): search (part ' +
    'of the name, any case), providerSlug, gameType, reviewStatus (any of pending, ' +
    'auto_approved, approved, declined), active (whether it is switched on in the lobby) and ' +
    'gameCategoryId (from games.categories). Each carries its gameId, name, slug, provider name, ' +
    'game type, review status, isActive, isUnavailable (the vendor marked it unavailable) and the ' +
    'categories it is in, each with its gameCategoryId and name (at most 10, in category order). ' +
    'Lists at most limit games (1 to 50, default 20); total counts every match and truncated is ' +
    'true when more matched. Use gaming.top_games for how a game performs.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'game-config', action: 'view' },
  inputSchema: GamesFindInputSchema,
  outputSchema: GamesFindOutputSchema,
  redact: { allow: ['total', 'truncated', 'games'] },
  errors: [],
});

/** At most this many categories games.categories lists. */
export const GAME_CATEGORIES_MAX = 200;

export const GameCategoriesInputSchema = z.object({ active: z.boolean().optional() });
export type GameCategoriesInput = z.infer<typeof GameCategoriesInputSchema>;

export const GameCategoriesOutputSchema = z.object({
  categories: z
    .array(
      z.object({
        gameCategoryId: UuidSchema,
        slug: z.string(),
        name: z.string(),
        isActive: z.boolean(),
        membershipMode: GameCategoryMembershipModeSchema,
        sortOrder: z.number().int(),
        gameCount: z.number().int().nonnegative(),
      }),
    )
    .max(GAME_CATEGORIES_MAX),
  truncated: z.boolean(),
});
export type GameCategories = z.infer<typeof GameCategoriesOutputSchema>;

export const gameCategoriesTool = defineMcpTool({
  id: 'games.categories',
  title: 'Game categories',
  description:
    'Lists the lobby game categories in their lobby order (sortOrder, then name), each with its ' +
    'gameCategoryId, slug, name, isActive, membershipMode (manual: games added by hand; rule: ' +
    'filled by its rule) and gameCount, the games in it whether switched on or not. active ' +
    'narrows them to the categories switched on or off. At most 200; truncated is true when ' +
    'there are more. Pass a gameCategoryId to games.find to list its games.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'game-config', action: 'view' },
  inputSchema: GameCategoriesInputSchema,
  outputSchema: GameCategoriesOutputSchema,
  redact: { allow: ['categories', 'truncated'] },
  errors: [],
});
