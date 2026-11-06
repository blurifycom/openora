import * as z from 'zod';
import {
  CurrencyTickerSchema,
  FIND_TOOL_MAX_LIMIT,
  FindToolLimitSchema,
  MoneyAmountSchema,
  MoneyThresholdSchema,
  SPORTSBOOK_BET_RESULTS,
  SPORTSBOOK_BET_STATUSES,
  SignedMoneyAmountSchema,
  SportsbookBetResultSchema,
  SportsbookBetStatusSchema,
  TimestampSchema,
  UuidSchema,
  checkDayRange,
  defineMcpTool,
  resolveDayRange,
  type DayRangeInput,
} from '@openora/core/contracts';

const TURNOVER_EXPOSURE_DEFAULT_DAYS = 30;
export const TURNOVER_EXPOSURE_MAX_DAYS = 92;
export const TURNOVER_EXPOSURE_MAX_CURRENCIES = 20;
export const LARGEST_OPEN_BETS_MAX = 20;

/** sportsbook.turnover_exposure's days: `dateTo` defaults to the day of `now`, `dateFrom` to 30 days ending on it. */
export function resolveTurnoverExposureRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, TURNOVER_EXPOSURE_DEFAULT_DAYS, now);
}

export const TurnoverExposureInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    largestOpen: z.coerce.number().int().min(0).max(LARGEST_OPEN_BETS_MAX).default(5),
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolveTurnoverExposureRange(input), TURNOVER_EXPOSURE_MAX_DAYS, ctx),
  );
export type TurnoverExposureInput = z.infer<typeof TurnoverExposureInputSchema>;

export const OpenBetStatusSchema = SportsbookBetStatusSchema.extract(['reserved', 'accepted']);

export const TurnoverExposureOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  currencies: z
    .array(
      z.object({
        currency: CurrencyTickerSchema,
        bets: z.number().int().nonnegative(),
        stake: MoneyAmountSchema,
        cashStake: MoneyAmountSchema,
        promotionStake: MoneyAmountSchema,
        payout: MoneyAmountSchema,
        cashPayout: MoneyAmountSchema,
        promotionPayout: MoneyAmountSchema,
        ggr: SignedMoneyAmountSchema,
        openBets: z.number().int().nonnegative(),
        openExposure: MoneyAmountSchema,
        openPotentialPayout: MoneyAmountSchema,
        largestOpen: z
          .array(
            z.object({
              betId: UuidSchema,
              playerId: UuidSchema.nullable(),
              status: OpenBetStatusSchema,
              stake: MoneyAmountSchema,
              potentialPayout: MoneyAmountSchema,
              legs: z.number().int().nonnegative(),
              placedAt: TimestampSchema,
              lastLegStartsAt: TimestampSchema,
            }),
          )
          .max(LARGEST_OPEN_BETS_MAX),
      }),
    )
    .max(TURNOVER_EXPOSURE_MAX_CURRENCIES),
  truncated: z.boolean(),
});
export type TurnoverExposure = z.infer<typeof TurnoverExposureOutputSchema>;

export const turnoverExposureTool = defineMcpTool({
  id: 'sportsbook.turnover_exposure',
  title: 'Sportsbook turnover and exposure',
  description:
    'Operator-wide sportsbook figures per currency over whole UTC days from dateFrom through ' +
    'dateTo (defaults to the 30 days ending today; a range spans at most 92 days), as each bet ' +
    'stands now and as the per-player sportsbook summary counts them: bets and stake (cash and ' +
    'promotion-funded) of the bets accepted, or still reserved, in range; payout (cash and ' +
    'promotion-funded, a void returning its stake included) of the bets settled in range; and ' +
    'GGR, cash stake minus payout. The open figures are now, whatever the range: openBets, ' +
    'openExposure (their stakes) and openPotentialPayout (what they pay if every one wins), with ' +
    'the largestOpen open bets by potential payout (0 to 20, default 5), each with its betId, ' +
    'playerId, stake, potential payout, number of legs and when its last leg starts. Narrow with ' +
    'currency. At most 20 currencies, alphabetical; truncated is true when more had bets. ' +
    'Amounts are decimal strings in the row currency and are never summed across currencies. ' +
    'No selection, event or market is returned.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'sportsbook', action: 'view' },
  inputSchema: TurnoverExposureInputSchema,
  outputSchema: TurnoverExposureOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'currencies', 'truncated'] },
  errors: [],
});

const BETS_FIND_DEFAULT_DAYS = 30;
export const BETS_FIND_MAX_DAYS = 92;

export const BETS_FIND_SORT_FIELDS = ['placedAt', 'stake', 'potentialPayout'] as const;
export const BetsFindSortBySchema = z.enum(BETS_FIND_SORT_FIELDS);
export type BetsFindSortBy = z.infer<typeof BetsFindSortBySchema>;

/** sportsbook.bets_find's days: `placedTo` defaults to the day of `now`, `placedFrom` to 30 days ending on it. */
export function resolveBetsFindRange(
  { placedFrom, placedTo }: { placedFrom?: string; placedTo?: string },
  now = new Date(),
) {
  return resolveDayRange({ dateFrom: placedFrom, dateTo: placedTo }, BETS_FIND_DEFAULT_DAYS, now);
}

export const BetsFindInputSchema = z
  .object({
    status: z.array(SportsbookBetStatusSchema).max(SPORTSBOOK_BET_STATUSES.length).optional(),
    result: z.array(SportsbookBetResultSchema).max(SPORTSBOOK_BET_RESULTS.length).optional(),
    playerId: UuidSchema.optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    placedFrom: z.iso.date().optional(),
    placedTo: z.iso.date().optional(),
    minStake: MoneyThresholdSchema.optional(),
    sortBy: BetsFindSortBySchema.default('placedAt'),
    sortDir: z.enum(['desc', 'asc']).default('desc'),
    limit: FindToolLimitSchema,
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolveBetsFindRange(input), BETS_FIND_MAX_DAYS, ctx, {
      from: 'placedFrom',
      to: 'placedTo',
    }),
  );
export type BetsFindInput = z.infer<typeof BetsFindInputSchema>;

export const BetsFindOutputSchema = z.object({
  placedFrom: z.iso.date(),
  placedTo: z.iso.date(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  bets: z
    .array(
      z.object({
        betId: UuidSchema,
        playerId: UuidSchema.nullable(),
        status: SportsbookBetStatusSchema,
        result: SportsbookBetResultSchema.nullable(),
        currency: CurrencyTickerSchema,
        stake: MoneyAmountSchema,
        potentialPayout: MoneyAmountSchema,
        payoutTotal: MoneyAmountSchema,
        legs: z.number().int().nonnegative(),
        placedAt: TimestampSchema,
        settledAt: TimestampSchema.nullable(),
      }),
    )
    .max(FIND_TOOL_MAX_LIMIT),
});
export type BetsFind = z.infer<typeof BetsFindOutputSchema>;

export const betsFindTool = defineMcpTool({
  id: 'sportsbook.bets_find',
  title: 'Find sportsbook bets',
  description:
    'Lists the sportsbook bets placed over whole UTC days from placedFrom through placedTo ' +
    '(defaults to the 30 days ending today, at most 92 days; both are returned) that match ' +
    'every filter given: status (any of reserved, accepted, cancelled, settled), result (any of ' +
    'won, lost, void, half_won, half_lost, cashed_out), playerId, currency and minStake. Each ' +
    'carries its betId and playerId, status, result (null until settled), currency, stake, ' +
    'potential payout, what its settlement paid, number of legs, when it was placed and ' +
    'settled. sortBy placedAt (default), stake or potentialPayout, sortDir desc (default) or ' +
    'asc. Lists at most limit bets (1 to 50, default 20); total counts every match and truncated ' +
    'is true when more matched. Amounts are decimal strings in the bet currency; narrow by ' +
    'currency to compare them. No selection, event or market is returned.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'sportsbook', action: 'view' },
  inputSchema: BetsFindInputSchema,
  outputSchema: BetsFindOutputSchema,
  redact: { allow: ['placedFrom', 'placedTo', 'total', 'truncated', 'bets'] },
  errors: [],
});
