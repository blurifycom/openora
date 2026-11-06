import * as z from 'zod';
import {
  CurrencyTickerSchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
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
