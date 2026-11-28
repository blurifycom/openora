import * as z from 'zod';
import {
  CurrencyTickerSchema,
  MoneyAmountSchema,
  checkDayRange,
  defineMcpTool,
  resolveDayRange,
  type DayRangeInput,
} from '@openora/core/contracts';

const RAKEBACK_LIABILITY_DEFAULT_DAYS = 30;
export const RAKEBACK_LIABILITY_MAX_DAYS = 366;
export const RAKEBACK_LIABILITY_MAX_CURRENCIES = 20;

export function resolveRakebackLiabilityRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, RAKEBACK_LIABILITY_DEFAULT_DAYS, now);
}

export const RakebackLiabilityInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolveRakebackLiabilityRange(input), RAKEBACK_LIABILITY_MAX_DAYS, ctx),
  );
export type RakebackLiabilityInput = z.infer<typeof RakebackLiabilityInputSchema>;

const RakebackFigureSchema = z.object({
  amount: MoneyAmountSchema,
  accruals: z.number().int().nonnegative(),
  players: z.number().int().nonnegative(),
});

const RankRewardFigureSchema = z.object({
  amount: MoneyAmountSchema,
  rewards: z.number().int().nonnegative(),
  players: z.number().int().nonnegative(),
});

export const RakebackLiabilityOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  currencies: z
    .array(
      z.object({
        currency: CurrencyTickerSchema,
        unclaimed: RakebackFigureSchema,
        accrued: RakebackFigureSchema,
        claimed: RakebackFigureSchema,
      }),
    )
    .max(RAKEBACK_LIABILITY_MAX_CURRENCIES),
  truncated: z.boolean(),
  rankRewards: z.object({
    currencies: z
      .array(
        z.object({
          currency: CurrencyTickerSchema,
          unclaimed: RankRewardFigureSchema,
          created: RankRewardFigureSchema,
          paid: RankRewardFigureSchema,
        }),
      )
      .max(RAKEBACK_LIABILITY_MAX_CURRENCIES),
    truncated: z.boolean(),
  }),
});
export type RakebackLiabilityReport = z.infer<typeof RakebackLiabilityOutputSchema>;

export const rakebackLiabilityTool = defineMcpTool({
  id: 'bonus.rakeback_liability',
  title: 'Rakeback liability',
  description:
    'The rakeback the operator owes and pays, per currency: unclaimed - accrued and not yet ' +
    'claimed, now, which is the liability - and over whole UTC days from dateFrom through dateTo ' +
    '(default: the 30 days ending today; at most 366 days) what accrued, whatever became of it ' +
    'since, and what players claimed, by when they claimed it. Each as an amount, the accruals ' +
    'and the distinct players behind it. A voided accrual counts in accrued only. Narrow with ' +
    'currency. At most 20 currencies, alphabetical; truncated is true when more had rakeback. ' +
    'Amounts are decimal strings in the row currency, never converted or summed across ' +
    'currencies. rankRewards reports the claim-mode daily, weekly and monthly rank rewards the ' +
    'same way, apart from rakeback: unclaimed now, created over the range, and paid (claimed or ' +
    'auto-paid) over the range. Names no player.',
  class: 'read',
  schemaVersion: 2,
  iam: { resource: 'bonus', action: 'view' },
  inputSchema: RakebackLiabilityInputSchema,
  outputSchema: RakebackLiabilityOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'currencies', 'truncated', 'rankRewards'] },
  errors: [],
});
