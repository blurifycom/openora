import * as z from 'zod';
import {
  BONUS_FORFEIT_REASONS,
  BONUS_GRANT_SOURCES,
  BONUS_GRANT_STATUSES,
  BonusForfeitReasonSchema,
  BonusGrantSourceSchema,
  BonusGrantStatusSchema,
  CurrencyTickerSchema,
  FIND_TOOL_MAX_LIMIT,
  FindToolLimitSchema,
  MoneyAmountSchema,
  TimestampSchema,
  UuidSchema,
  checkDayBounds,
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

/** How far ahead bonus.grants_find's expiringWithinDays may look. */
export const GRANTS_FIND_MAX_EXPIRING_DAYS = 90;

export const GrantsFindInputSchema = z
  .object({
    status: z.array(BonusGrantStatusSchema).max(BONUS_GRANT_STATUSES.length).optional(),
    source: z.array(BonusGrantSourceSchema).max(BONUS_GRANT_SOURCES.length).optional(),
    playerId: UuidSchema.optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    activatedFrom: z.iso.date().optional(),
    activatedTo: z.iso.date().optional(),
    expiringWithinDays: z.coerce
      .number()
      .int()
      .min(1)
      .max(GRANTS_FIND_MAX_EXPIRING_DAYS)
      .optional(),
    limit: FindToolLimitSchema,
  })
  .superRefine((input, ctx) =>
    checkDayBounds(
      input.activatedFrom,
      input.activatedTo,
      { from: 'activatedFrom', to: 'activatedTo' },
      ctx,
    ),
  );
export type GrantsFindInput = z.infer<typeof GrantsFindInputSchema>;

export const GrantsFindOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  grants: z
    .array(
      z.object({
        grantId: UuidSchema,
        playerId: UuidSchema.nullable(),
        status: BonusGrantStatusSchema,
        source: BonusGrantSourceSchema,
        currency: CurrencyTickerSchema,
        grantedAmount: MoneyAmountSchema,
        bonusBalance: MoneyAmountSchema,
        wageringRequired: MoneyAmountSchema,
        wageringProgress: MoneyAmountSchema,
        activatedAt: TimestampSchema.nullable(),
        expiresAt: TimestampSchema,
        closedAt: TimestampSchema.nullable(),
        forfeitReason: BonusForfeitReasonSchema.nullable(),
      }),
    )
    .max(FIND_TOOL_MAX_LIMIT),
});
export type GrantsFind = z.infer<typeof GrantsFindOutputSchema>;

export const grantsFindTool = defineMcpTool({
  id: 'bonus.grants_find',
  title: 'Find bonus grants',
  description:
    'Lists the bonus grants matching every filter given: status (any of pending - claimed, not ' +
    'funded -, active, completed - wagering met and converted -, expired, forfeited, ' +
    'cancelled), source (any of deposit, manual, streak, rank, race, gift, rain, cashback, ' +
    'donation), playerId, currency, activatedFrom/activatedTo (whole UTC days the grant was ' +
    'funded, either end optional) and expiringWithinDays (1 to 90: only the pending and active ' +
    'grants that expire within that many days from now). Each carries its grantId and playerId, ' +
    'status, source, currency, the bonus granted, the bonus balance left, the wagering required ' +
    'and done so far, when it was funded, expires and closed, and why it was forfeited. Newest ' +
    'first, or soonest to expire first with expiringWithinDays. Lists at most limit grants (1 ' +
    'to 50, default 20); total counts every match and truncated is true when more matched. ' +
    'Amounts are decimal strings in the grant currency. No admin note is returned.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'bonus', action: 'view' },
  inputSchema: GrantsFindInputSchema,
  outputSchema: GrantsFindOutputSchema,
  redact: { allow: ['total', 'truncated', 'grants'] },
  errors: [],
});
