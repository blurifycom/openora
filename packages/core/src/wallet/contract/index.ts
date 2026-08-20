import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  KycStatusSchema,
  MoneyAmountSchema,
  TagKeySchema,
  TimestampSchema,
  UuidSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

export { WalletRailSchema, WalletTransactionStatusSchema, WalletTransactionTypeSchema };

// Deposit/withdraw amounts must be strictly positive; balances/thresholds may be zero.
const PositiveMoneyAmountSchema = MoneyAmountSchema.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

// ISO 4217 plus longer crypto tickers (USDT, USDC). Codes are canonically uppercase -
// normalize on the way in so a `usd` request can never diverge from a `USD` wallet.
const WalletCurrencyCodeSchema = z
  .string()
  .regex(/^[A-Za-z]{3,10}$/, 'currency code, e.g. USD or USDT');

const WalletCurrencyInputSchema = WalletCurrencyCodeSchema.transform((c) => c.toUpperCase());

export const WalletBalanceSchema = z.object({
  balance: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
});

export const WalletBalancesSchema = z.object({
  activeCurrency: WalletCurrencyCodeSchema,
  balances: z.array(WalletBalanceSchema),
});

export const SetActiveCurrencyInputSchema = z.object({ currency: WalletCurrencyCodeSchema });

export const ActiveCurrencySchema = z.object({ activeCurrency: WalletCurrencyCodeSchema });

export const WalletTransactionSchema = z.object({
  id: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  status: WalletTransactionStatusSchema,
  createdAt: TimestampSchema,
});

export const AdminWalletTransactionSchema = WalletTransactionSchema.extend({
  reviewedBy: UuidSchema.nullable(),
  reviewedAt: TimestampSchema.nullable(),
  reviewReason: z.string().nullable(),
});
export type AdminWalletTransaction = z.infer<typeof AdminWalletTransactionSchema>;

export const DepositInputSchema = z.object({
  amount: PositiveMoneyAmountSchema,
  currency: WalletCurrencyInputSchema,
  provider: z.string().optional(),
  idempotencyKey: UuidSchema.optional(),
});

export const WithdrawInputSchema = z.object({
  amount: PositiveMoneyAmountSchema,
  currency: WalletCurrencyInputSchema,
  provider: z.string().optional(),
  idempotencyKey: UuidSchema.optional(),
  destinationAddress: z.string().optional(),
});

export const MANUAL_ADJUSTMENT_DIRECTIONS = ['credit', 'debit'] as const;
export const ManualAdjustmentDirectionSchema = z.enum(MANUAL_ADJUSTMENT_DIRECTIONS);
export type ManualAdjustmentDirection = z.infer<typeof ManualAdjustmentDirectionSchema>;

export const ManualWalletAdjustmentInputSchema = z.object({
  userId: UuidSchema,
  direction: ManualAdjustmentDirectionSchema,
  currency: WalletCurrencyInputSchema,
  amount: PositiveMoneyAmountSchema,
  reason: z.string().trim().min(1),
  idempotencyKey: UuidSchema,
});
export type ManualWalletAdjustmentInput = z.infer<typeof ManualWalletAdjustmentInputSchema>;

export const TransactionResultSchema = z.object({
  transactionId: UuidSchema,
  status: WalletTransactionStatusSchema,
});
export type TransactionResult = z.infer<typeof TransactionResultSchema>;

export const WALLET_TX_SORT_BY_VALUES = [
  'createdAt',
  'amount',
  'type',
  'status',
  'currency',
  'rail',
  'reviewedAt',
] as const;
export const WalletTransactionSortBySchema = z.enum(WALLET_TX_SORT_BY_VALUES).default('createdAt');
export type WalletTransactionSortBy = z.infer<typeof WalletTransactionSortBySchema>;

export const WITHDRAWAL_SORT_BY_VALUES = [
  'createdAt',
  'amount',
  'status',
  'currency',
  'rail',
  'reviewedAt',
] as const;
export const WithdrawalSortBySchema = z.enum(WITHDRAWAL_SORT_BY_VALUES).default('createdAt');
export type WithdrawalSortBy = z.infer<typeof WithdrawalSortBySchema>;

export const ListPlayerTransactionsArgs = PageQuerySchema.extend({
  userId: UuidSchema,
  sortBy: WalletTransactionSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});

export const WithdrawalQueueItemSchema = z.object({
  transactionId: UuidSchema,
  userId: UuidSchema,
  playerId: UuidSchema.nullable(),
  username: z.string(),
  amount: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  rail: WalletRailSchema.nullable(),
  status: WalletTransactionStatusSchema,
  kycStatus: KycStatusSchema.nullable(),
  riskTags: z.array(z.string()),
  requestedAt: TimestampSchema,
  destinationAddress: z.string().nullable(),
  txHash: z.string().nullable(),
});
export type WithdrawalQueueItem = z.infer<typeof WithdrawalQueueItemSchema>;

export const WithdrawalQueueFilterSchema = PageQuerySchema.extend({
  status: WalletTransactionStatusSchema.optional(),
  currency: WalletCurrencyInputSchema.optional(),
  rail: WalletRailSchema.optional(),
  minAmount: MoneyAmountSchema.optional(),
  maxAmount: MoneyAmountSchema.optional(),
  kycStatus: KycStatusSchema.optional(),
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
  sortBy: WithdrawalSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});
export type WithdrawalQueueFilter = z.infer<typeof WithdrawalQueueFilterSchema>;

export const AutoWithdrawalRuleSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  threshold: MoneyAmountSchema,
  reason: z.string(),
  createdBy: UuidSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AutoWithdrawalRule = z.infer<typeof AutoWithdrawalRuleSchema>;

export const SetAutoWithdrawalRuleInputSchema = z.object({
  userId: UuidSchema,
  threshold: PositiveMoneyAmountSchema,
  reason: z.string().min(1),
});

export const AutoWithdrawalRuleKeySchema = z.object({ userId: UuidSchema });

export const WalletAutoWithdrawalConfigSchema = z.object({
  id: UuidSchema,
  fiatThreshold: MoneyAmountSchema,
  cryptoThreshold: MoneyAmountSchema,
  excludeRiskFlags: z.array(TagKeySchema),
  updatedBy: UuidSchema.nullable(),
  updatedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type WalletAutoWithdrawalConfig = z.infer<typeof WalletAutoWithdrawalConfigSchema>;

// wallet_auto_withdrawal_config.{fiatThreshold,cryptoThreshold} are decimal(18,8) - 10
// integer digits max. Bounded here (not in the shared MoneyAmountSchema, which also backs
// decimal(18,2) columns with a different integer-digit budget) so an out-of-range value is
// a 4xx at the contract boundary instead of a DB overflow 500.
const WalletAutoWithdrawalThresholdSchema = MoneyAmountSchema.refine(
  (v) => (v.split('.').at(0) ?? '').length <= 10,
  { message: 'must have at most 10 integer digits' },
);

export const SetWalletAutoWithdrawalConfigInputSchema = z.object({
  fiatThreshold: WalletAutoWithdrawalThresholdSchema,
  cryptoThreshold: WalletAutoWithdrawalThresholdSchema,
  excludeRiskFlags: z.array(TagKeySchema),
});

export const ApproveWithdrawalInputSchema = z.object({ withdrawalId: UuidSchema });

export const RejectWithdrawalInputSchema = z.object({
  withdrawalId: UuidSchema,
  reason: z.string().min(1),
});

export const PaymentWebhookInputSchema = z.record(z.string(), z.unknown());
export const PaymentWebhookOutputSchema = z.object({ ok: z.literal(true) });

export const DepositAddressInputSchema = z.object({
  currency: WalletCurrencyInputSchema,
  network: z.string().min(1).optional(),
});
export const DepositAddressSchema = z.object({
  address: z.string(),
  currency: WalletCurrencyCodeSchema,
  network: z.string().optional(),
  tag: z.string().optional(),
});

export const walletContract = {
  getBalance: oc.route({ method: 'GET', path: '/wallet/balance' }).output(WalletBalanceSchema),

  getBalances: oc.route({ method: 'GET', path: '/wallet/balances' }).output(WalletBalancesSchema),

  setActiveCurrency: oc
    .route({ method: 'PUT', path: '/wallet/active-currency' })
    .input(SetActiveCurrencyInputSchema)
    .output(ActiveCurrencySchema),

  deposit: oc
    .route({ method: 'POST', path: '/wallet/deposit' })
    .input(DepositInputSchema)
    .output(TransactionResultSchema),

  withdraw: oc
    .route({ method: 'POST', path: '/wallet/withdraw' })
    .input(WithdrawInputSchema)
    .output(TransactionResultSchema),

  manualAdjustment: oc
    .route({ method: 'POST', path: '/wallet/manual-adjustments' })
    .input(ManualWalletAdjustmentInputSchema)
    .output(TransactionResultSchema),

  listTransactions: oc
    .route({ method: 'GET', path: '/wallet/transactions' })
    .input(
      PageQuerySchema.extend({
        sortBy: WalletTransactionSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
    .output(paginated(WalletTransactionSchema)),

  listPlayerTransactions: oc
    .route({ method: 'GET', path: '/wallet/transactions/{userId}' })
    .input(ListPlayerTransactionsArgs)
    .output(paginated(AdminWalletTransactionSchema)),

  withdrawals: {
    list: oc
      .route({ method: 'GET', path: '/wallet/withdrawals' })
      .input(WithdrawalQueueFilterSchema)
      .output(paginated(WithdrawalQueueItemSchema)),

    approve: oc
      .route({ method: 'POST', path: '/wallet/withdrawals/{withdrawalId}/approve' })
      .input(ApproveWithdrawalInputSchema)
      .output(TransactionResultSchema),

    reject: oc
      .route({ method: 'POST', path: '/wallet/withdrawals/{withdrawalId}/reject' })
      .input(RejectWithdrawalInputSchema)
      .output(TransactionResultSchema),
  },

  autoWithdrawalRules: {
    set: oc
      .route({ method: 'PUT', path: '/wallet/auto-withdrawal-rules/{userId}' })
      .input(SetAutoWithdrawalRuleInputSchema)
      .output(AutoWithdrawalRuleSchema),

    get: oc
      .route({ method: 'GET', path: '/wallet/auto-withdrawal-rules/{userId}' })
      .input(AutoWithdrawalRuleKeySchema)
      .output(AutoWithdrawalRuleSchema.nullable()),

    delete: oc
      .route({ method: 'DELETE', path: '/wallet/auto-withdrawal-rules/{userId}' })
      .input(AutoWithdrawalRuleKeySchema)
      .output(z.boolean()),
  },

  autoWithdrawalConfig: {
    get: oc
      .route({ method: 'GET', path: '/wallet/auto-withdrawal-config' })
      .output(WalletAutoWithdrawalConfigSchema),

    set: oc
      .route({ method: 'PUT', path: '/wallet/auto-withdrawal-config' })
      .input(SetWalletAutoWithdrawalConfigInputSchema)
      .output(WalletAutoWithdrawalConfigSchema),
  },

  deposits: {
    getAddress: oc
      .route({ method: 'POST', path: '/wallet/deposits/address' })
      .input(DepositAddressInputSchema)
      .output(DepositAddressSchema),
  },

  webhook: oc
    .route({ method: 'POST', path: '/wallet/webhook' })
    .input(PaymentWebhookInputSchema)
    .output(PaymentWebhookOutputSchema),
};
