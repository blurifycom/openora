import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  KycStatusSchema,
  MoneyAmountSchema,
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

const WalletCurrencyCodeSchema = z.string().min(1);

export const WalletBalanceSchema = z.object({
  balance: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
});

export const WalletTransactionSchema = z.object({
  id: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: MoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  status: WalletTransactionStatusSchema,
  createdAt: TimestampSchema,
});

export const DepositInputSchema = z.object({
  amount: PositiveMoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  provider: z.string().optional(),
  idempotencyKey: UuidSchema.optional(),
});

export const WithdrawInputSchema = z.object({
  amount: PositiveMoneyAmountSchema,
  currency: WalletCurrencyCodeSchema,
  provider: z.string().optional(),
  idempotencyKey: UuidSchema.optional(),
  destinationAddress: z.string().optional(),
});

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
  currency: WalletCurrencyCodeSchema.optional(),
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
  updatedBy: UuidSchema.nullable(),
  updatedAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type WalletAutoWithdrawalConfig = z.infer<typeof WalletAutoWithdrawalConfigSchema>;

export const SetWalletAutoWithdrawalConfigInputSchema = z.object({
  fiatThreshold: MoneyAmountSchema,
  cryptoThreshold: MoneyAmountSchema,
});

export const ApproveWithdrawalInputSchema = z.object({ withdrawalId: UuidSchema });

export const RejectWithdrawalInputSchema = z.object({
  withdrawalId: UuidSchema,
  reason: z.string().min(1),
});

export const PaymentWebhookInputSchema = z.record(z.string(), z.unknown());
export const PaymentWebhookOutputSchema = z.object({ ok: z.literal(true) });

export const DepositAddressInputSchema = z.object({ currency: WalletCurrencyCodeSchema });
export const DepositAddressSchema = z.object({
  address: z.string(),
  currency: WalletCurrencyCodeSchema,
});

export const walletContract = {
  getBalance: oc.route({ method: 'GET', path: '/wallet/balance' }).output(WalletBalanceSchema),

  deposit: oc
    .route({ method: 'POST', path: '/wallet/deposit' })
    .input(DepositInputSchema)
    .output(TransactionResultSchema),

  withdraw: oc
    .route({ method: 'POST', path: '/wallet/withdraw' })
    .input(WithdrawInputSchema)
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
    .output(paginated(WalletTransactionSchema)),

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
