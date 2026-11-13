import * as z from 'zod';
import {
  CurrencyTickerSchema,
  GranularitySchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
  WALLET_TRANSACTION_STATUSES,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
  defineMcpTool,
} from '@openora/core/contracts';
import { GgrSeriesSchema, ProductRevenueSchema } from './financial.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const GGR_SUMMARY_DEFAULT_DAYS = 30;
export const GGR_SUMMARY_MAX_DAYS = 366;
const PAYMENTS_FLOW_DEFAULT_DAYS = 14;
export const PAYMENTS_FLOW_MAX_DAYS = 92;
export const PAYMENTS_FLOW_MAX_ROWS = 1000;
const FINANCIAL_SUMMARY_DEFAULT_DAYS = 30;
export const FINANCIAL_SUMMARY_MAX_DAYS = 366;
export const FINANCIAL_SUMMARY_MAX_CURRENCIES = 100;
export const FINANCIAL_SUMMARY_MAX_PRODUCT_ROWS = 300;

type DayRangeInput = { dateFrom?: string; dateTo?: string };
type DayRange = { dateFrom: string; dateTo: string };

const isoDay = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

/**
 * The whole UTC days a report covers, both ends inclusive: `dateTo` defaults to the day of
 * `now`, and `dateFrom` to the `defaultDays` days ending on `dateTo`.
 */
function resolveDayRange(
  { dateFrom, dateTo }: DayRangeInput,
  defaultDays: number,
  now: Date,
): DayRange {
  const to = dateTo ?? isoDay(now.getTime());
  return {
    dateFrom: dateFrom ?? isoDay(Date.parse(to) - (defaultDays - 1) * DAY_MS),
    dateTo: to,
  };
}

function dayRangeDays({ dateFrom, dateTo }: DayRange) {
  return (Date.parse(dateTo) - Date.parse(dateFrom)) / DAY_MS + 1;
}

function checkDayRange(range: DayRange, maxDays: number, ctx: z.core.$RefinementCtx) {
  if (range.dateFrom > range.dateTo) {
    ctx.addIssue({
      code: 'custom',
      path: ['dateFrom'],
      message: 'dateFrom must be on or before dateTo',
    });
    return;
  }
  if (dayRangeDays(range) > maxDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['dateFrom'],
      message: `the range spans at most ${maxDays} days`,
    });
  }
}

/** ggr.summary's days: `dateTo` defaults to the day of `now`, `dateFrom` to 30 days ending on it. */
export function resolveGgrSummaryRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, GGR_SUMMARY_DEFAULT_DAYS, now);
}

/** payments.flow_daily's days: `dateTo` defaults to the day of `now`, `dateFrom` to 14 days ending on it. */
export function resolvePaymentsFlowRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, PAYMENTS_FLOW_DEFAULT_DAYS, now);
}

/** financial.summary's days: `dateTo` defaults to the day of `now`, `dateFrom` to 30 days ending on it. */
export function resolveFinancialSummaryRange(input: DayRangeInput, now = new Date()) {
  return resolveDayRange(input, FINANCIAL_SUMMARY_DEFAULT_DAYS, now);
}

export const GgrSummaryInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    granularity: GranularitySchema.default('week'),
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolveGgrSummaryRange(input), GGR_SUMMARY_MAX_DAYS, ctx),
  );
export type GgrSummaryInput = z.infer<typeof GgrSummaryInputSchema>;

export const GgrSummaryOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  granularity: GranularitySchema,
  series: z.array(GgrSeriesSchema.extend({ currency: CurrencyTickerSchema })),
});
export type GgrSummary = z.infer<typeof GgrSummaryOutputSchema>;

export const ggrSummaryTool = defineMcpTool({
  id: 'ggr.summary',
  title: 'GGR summary',
  description:
    'Operator-wide gross gaming revenue - completed bets minus bet reversals minus wins plus win ' +
    'reversals - per ' +
    'currency, in day, week or month buckets over whole UTC days from dateFrom through dateTo. ' +
    'Defaults to the 30 days ending today; a range spans at most 366 days. Amounts are decimal ' +
    'strings and can be negative.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'analytics', action: 'view' },
  inputSchema: GgrSummaryInputSchema,
  outputSchema: GgrSummaryOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'granularity', 'series'] },
  errors: [],
});

export const PaymentFlowTypeSchema = WalletTransactionTypeSchema.extract(['deposit', 'withdrawal']);
export const PAYMENT_FLOW_TYPES = PaymentFlowTypeSchema.options;
export type PaymentFlowType = z.infer<typeof PaymentFlowTypeSchema>;

export const PaymentFlowGranularitySchema = GranularitySchema.extract(['day', 'week']);
export type PaymentFlowGranularity = z.infer<typeof PaymentFlowGranularitySchema>;

export const PaymentsFlowInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    types: z.array(PaymentFlowTypeSchema).min(1).max(PAYMENT_FLOW_TYPES.length).optional(),
    statuses: z
      .array(WalletTransactionStatusSchema)
      .min(1)
      .max(WALLET_TRANSACTION_STATUSES.length)
      .optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
    granularity: PaymentFlowGranularitySchema.default('day'),
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolvePaymentsFlowRange(input), PAYMENTS_FLOW_MAX_DAYS, ctx),
  );
export type PaymentsFlowInput = z.infer<typeof PaymentsFlowInputSchema>;

export const PaymentFlowRowSchema = z.object({
  bucket: z.iso.date(),
  type: PaymentFlowTypeSchema,
  status: WalletTransactionStatusSchema,
  currency: CurrencyTickerSchema,
  count: z.number().int().nonnegative(),
  amount: MoneyAmountSchema,
});
export type PaymentFlowRow = z.infer<typeof PaymentFlowRowSchema>;

export const PaymentsFlowOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  granularity: PaymentFlowGranularitySchema,
  rows: z.array(PaymentFlowRowSchema).max(PAYMENTS_FLOW_MAX_ROWS),
  truncated: z.boolean(),
});
export type PaymentsFlow = z.infer<typeof PaymentsFlowOutputSchema>;

export const paymentsFlowDailyTool = defineMcpTool({
  id: 'payments.flow_daily',
  title: 'Payments flow',
  description:
    'Operator-wide deposits and withdrawals as one row per UTC day (or ISO week, labelled by its ' +
    'Monday), type, status and currency, with how many there were and their summed amount. A row ' +
    'counts the transactions created in its bucket under the status they hold now: pending, ' +
    'processing, completed, failed, rejected, on_hold (manual review, AML holds included), ' +
    'cancelled or refunded. Covers whole UTC days from dateFrom through dateTo; defaults to the ' +
    '14 days ending today, and a range spans at most 92 days. Narrow it with types, statuses or ' +
    'currency. At most 1000 rows, oldest bucket first; truncated is true when more matched, so ' +
    'narrow the range or the filters. Amounts are decimal strings in the row currency and are ' +
    'never summed across currencies. Names no player.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'analytics', action: 'view' },
  inputSchema: PaymentsFlowInputSchema,
  outputSchema: PaymentsFlowOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'granularity', 'rows', 'truncated'] },
  errors: [],
});

export const FinancialSummaryInputSchema = z
  .object({
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    currency: CurrencyTickerSchema.max(10).optional(),
  })
  .superRefine((input, ctx) =>
    checkDayRange(resolveFinancialSummaryRange(input), FINANCIAL_SUMMARY_MAX_DAYS, ctx),
  );
export type FinancialSummaryInput = z.infer<typeof FinancialSummaryInputSchema>;

export const FinancialCurrencyTotalsSchema = z.object({
  currency: CurrencyTickerSchema,
  deposits: MoneyAmountSchema,
  withdrawals: MoneyAmountSchema,
  netDeposits: SignedMoneyAmountSchema,
  ggr: SignedMoneyAmountSchema,
  bonusCost: SignedMoneyAmountSchema,
  ngr: SignedMoneyAmountSchema,
});
export type FinancialCurrencyTotals = z.infer<typeof FinancialCurrencyTotalsSchema>;

export const FinancialSummaryOutputSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  currencies: z.array(FinancialCurrencyTotalsSchema).max(FINANCIAL_SUMMARY_MAX_CURRENCIES),
  products: z.array(ProductRevenueSchema).max(FINANCIAL_SUMMARY_MAX_PRODUCT_ROWS),
  truncated: z.boolean(),
});
export type FinancialSummaryOverview = z.infer<typeof FinancialSummaryOutputSchema>;

export const financialSummaryTool = defineMcpTool({
  id: 'financial.summary',
  title: 'Financial summary',
  description:
    'Operator-wide money totals per currency over whole UTC days from dateFrom through dateTo ' +
    '(defaults to the 30 days ending today; a range spans at most 366 days): completed deposits ' +
    'and withdrawals, net deposits (deposits minus withdrawals minus bonus cost), GGR from the ' +
    'wallet ledger (bets minus bet reversals minus wins plus win reversals), bonus cost and NGR ' +
    '(GGR minus bonus cost). Bonus cost is bonus money converted to cash once its wagering ' +
    'completed; rakeback and race, streak and rank-challenge rewards are paid as cashback and ' +
    'are not in it. products splits stakes, payouts and GGR by product from game rounds and the ' +
    'sportsbook ledger, so its GGR need not match the ledger GGR; rounds on a game the round ' +
    'ledger has not typed yet are product unclassified. At most 100 currencies and 300 ' +
    'product rows; truncated is true when a list was cut. Amounts are decimal strings, can be ' +
    'negative and are never summed across currencies.',
  class: 'read',
  schemaVersion: 1,
  iam: { resource: 'analytics', action: 'view' },
  inputSchema: FinancialSummaryInputSchema,
  outputSchema: FinancialSummaryOutputSchema,
  redact: { allow: ['dateFrom', 'dateTo', 'currencies', 'products', 'truncated'] },
  errors: [],
});
