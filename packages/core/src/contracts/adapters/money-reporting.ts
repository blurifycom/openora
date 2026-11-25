import * as z from 'zod';
import {
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
} from '../schemas/common.js';
import { GameTypeSchema } from '../schemas/game.js';
import { DateRangeSchema, GranularitySchema } from '../schemas/reporting.js';
import {
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
  type WalletTransactionStatus,
} from '../schemas/wallet-tx.js';
import type { Uuid } from '../schemas/index.js';
import { createToken, type Token } from './token.js';

export const MoneyByCurrencyRailSchema = z.object({
  currency: CurrencyTickerSchema,
  rail: WalletRailSchema.nullable(),
  total: MoneyAmountSchema,
});
export type MoneyByCurrencyRail = z.infer<typeof MoneyByCurrencyRailSchema>;

export const MoneyByCurrencySchema = z.object({
  currency: CurrencyTickerSchema,
  total: SignedMoneyAmountSchema,
});
export type MoneyByCurrency = z.infer<typeof MoneyByCurrencySchema>;

export const FinancialSummarySchema = z.object({
  deposits: z.array(MoneyByCurrencyRailSchema),
  withdrawals: z.array(MoneyByCurrencyRailSchema),
  netDeposits: z.array(MoneyByCurrencySchema),
  ggr: z.array(MoneyByCurrencySchema),
  bonusCost: z.array(MoneyByCurrencySchema),
  sportsbookPromotionCost: z.array(MoneyByCurrencySchema),
  ngr: z.array(MoneyByCurrencySchema),
});
export type FinancialSummary = z.infer<typeof FinancialSummarySchema>;

export const FinancialSummaryQuerySchema = DateRangeSchema.extend({
  currency: CurrencyTickerInputSchema.optional(),
});
export type FinancialSummaryQuery = z.infer<typeof FinancialSummaryQuerySchema>;

export const GgrPointSchema = z.object({
  bucket: z.string(),
  ggr: SignedMoneyAmountSchema,
});

export const GgrSeriesSchema = z.object({
  currency: CurrencyTickerSchema,
  points: z.array(GgrPointSchema),
});
export type GgrSeries = z.infer<typeof GgrSeriesSchema>;

export const FinancialGgrQuerySchema = DateRangeSchema.extend({
  currency: CurrencyTickerInputSchema.optional(),
  granularity: GranularitySchema.default('day'),
});
export type FinancialGgrQuery = z.infer<typeof FinancialGgrQuerySchema>;

export const UNCLASSIFIED_PRODUCT = 'unclassified';
export const ProductRevenueSchema = z.object({
  product: z.union([GameTypeSchema, z.literal(UNCLASSIFIED_PRODUCT)]),
  currency: CurrencyTickerSchema,
  stakes: MoneyAmountSchema,
  payouts: SignedMoneyAmountSchema,
  ggr: SignedMoneyAmountSchema,
});
export type ProductRevenue = z.infer<typeof ProductRevenueSchema>;

export const PAYMENTS_FLOW_MAX_ROWS = 1000;

export const PaymentFlowTypeSchema = WalletTransactionTypeSchema.extract(['deposit', 'withdrawal']);
export const PAYMENT_FLOW_TYPES = PaymentFlowTypeSchema.options;
export type PaymentFlowType = z.infer<typeof PaymentFlowTypeSchema>;

export const PaymentFlowGranularitySchema = GranularitySchema.extract(['day', 'week']);
export type PaymentFlowGranularity = z.infer<typeof PaymentFlowGranularitySchema>;

export const PaymentFlowRowSchema = z.object({
  bucket: z.iso.date(),
  type: PaymentFlowTypeSchema,
  status: WalletTransactionStatusSchema,
  currency: CurrencyTickerSchema,
  count: z.number().int().nonnegative(),
  amount: MoneyAmountSchema,
});
export type PaymentFlowRow = z.infer<typeof PaymentFlowRowSchema>;

export type PaymentsFlowQuery = {
  dateFrom: string;
  dateTo: string;
  granularity: PaymentFlowGranularity;
  types: readonly PaymentFlowType[];
  statuses: readonly WalletTransactionStatus[] | null;
  currency: string | null;
};

export type MoneyFunnelActivity = { deposited: string[]; placedBet: string[] };

export type MoneyReportingPort = {
  summary(query: FinancialSummaryQuery): Promise<FinancialSummary>;
  ggr(query: FinancialGgrQuery): Promise<GgrSeries[]>;
  products(query: FinancialSummaryQuery): Promise<ProductRevenue[]>;
  paymentsFlow(query: PaymentsFlowQuery): Promise<PaymentFlowRow[]>;
  funnelActivity(userIds: readonly Uuid[]): Promise<MoneyFunnelActivity>;
};

export const MONEY_REPORTING: Token<MoneyReportingPort> =
  createToken<MoneyReportingPort>('MONEY_REPORTING');

export type PlayerRankReader = {
  getRankName(userId: Uuid): Promise<string | null>;
};

export const PLAYER_RANK_READER: Token<PlayerRankReader> =
  createToken<PlayerRankReader>('PLAYER_RANK_READER');
