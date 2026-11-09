import * as z from 'zod';
import {
  CurrencyTickerSchema,
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
  errors: ['report_unavailable'],
});
