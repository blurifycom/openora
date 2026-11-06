import * as z from 'zod';
import {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_SOURCES,
  BonusForfeitReasonSchema,
  BonusGrantSourceSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  checkDayRange,
  defineMcpTool,
  resolveDayRange,
  type DayRangeInput,
} from '@openora/core/contracts';

const GRANTS_SUMMARY_DEFAULT_DAYS = 30;
export const GRANTS_SUMMARY_MAX_DAYS = 366;
export const GRANTS_SUMMARY_MAX_CURRENCIES = 20;
/** How far ahead `outstanding.expiringSoon` looks. */
export const GRANTS_EXPIRING_SOON_DAYS = 7;

/** bonus.grants_summary's days: `dateTo` defaults to the day of `now`, `dateFrom` to 30 days ending on it. */
export function resolveGrantsSummaryRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, GRANTS_SUMMARY_DEFAULT_DAYS, now);
}

export const GrantsSummaryInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    source: BonusGrantSourceSchema.optional(),
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolveGrantsSummaryRange(input), GRANTS_SUMMARY_MAX_DAYS, ctx),
  );
export type GrantsSummaryInput = z.infer<typeof GrantsSummaryInputSchema>;

const CountedAmountSchema = z.object({
  count: z.number().int().nonnegative(),
  amount: MoneyAmountSchema,
});

export const GrantsSummaryCurrencySchema = z.object({
  currency: CurrencyTickerSchema,
  granted: CountedAmountSchema,
  converted: CountedAmountSchema,
  expired: CountedAmountSchema,
  forfeited: CountedAmountSchema.extend({
    byReason: z
      .array(z.object({ reason: BonusForfeitReasonSchema, count: z.number().int().positive() }))
      .max(BONUS_FORFEIT_REASONS.length),
  }),
  cancelled: z.number().int().nonnegative(),
  bySource: z
    .array(
      z.object({
        source: BonusGrantSourceSchema,
        granted: CountedAmountSchema,
        converted: CountedAmountSchema,
      }),
    )
    .max(BONUS_GRANT_SOURCES.length),
  outstanding: z.object({
    activeGrants: z.number().int().nonnegative(),
    pendingGrants: z.number().int().nonnegative(),
    bonusBalance: MoneyAmountSchema,
    wageringRemaining: MoneyAmountSchema,
    expiringSoon: CountedAmountSchema,
  }),
});
export type GrantsSummaryCurrency = z.infer<typeof GrantsSummaryCurrencySchema>;

export const GrantsSummaryOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  currencies: z.array(GrantsSummaryCurrencySchema).max(GRANTS_SUMMARY_MAX_CURRENCIES),
  truncated: z.boolean(),
});
export type GrantsSummary = z.infer<typeof GrantsSummaryOutputSchema>;

export const grantsSummaryTool = defineMcpTool({
  id: 'bonus.grants_summary',
  title: 'Bonus grants summary',
  description:
    'Operator-wide bonus grants per currency over whole UTC days from dateFrom through dateTo ' +
    '(defaults to the 30 days ending today; at most 366 days). granted: grants funded in range ' +
    'and the bonus they credited. Grants that ended in range: converted (wagering completed; ' +
    'amount is the bonus paid out as cash), expired and forfeited (amount is the bonus balance ' +
    'taken away; byReason counts why, e.g. self_exclusion or withdrawal_while_active) and ' +
    'cancelled (claimed, never funded). bySource splits granted and converted by what caused ' +
    'the grant (deposit, manual, cashback, race, ...). outstanding is now, whatever the range: ' +
    'active and pending grants, the bonus balance still on them (the liability), the wagering ' +
    'still required, and those expiring within 7 days. Narrow with currency or source. At most ' +
    '20 currencies, alphabetical; truncated is true when more had grants. Amounts are decimal ' +
    'strings in the row currency, never summed across currencies. Names no player.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'bonus', action: 'view' },
  inputSchema: GrantsSummaryInputSchema,
  outputSchema: GrantsSummaryOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'currencies', 'truncated'] },
  errors: [],
});
