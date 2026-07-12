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
import { PageQuerySchema, paginated } from '@openora/core/contracts/kit';

export { WalletRailSchema, WalletTransactionStatusSchema, WalletTransactionTypeSchema };

// Deposit/withdraw amounts must be strictly positive; balances/thresholds may be zero.
const PositiveMoneyAmountSchema = MoneyAmountSchema.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

// A wallet currency is either an ISO 4217 fiat code or a crypto asset ticker (eg USDT, 4
// letters) - never CurrencyCodeSchema (fixed 3-letter), which would reject the crypto rail.
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
  // Required for the crypto rail (where should the funds go?); ignored for fiat, where the
  // PSP resolves the payout destination from the player's on-file payment method.
  destinationAddress: z.string().optional(),
});

export const TransactionResultSchema = z.object({
  transactionId: UuidSchema,
  status: WalletTransactionStatusSchema,
});
export type TransactionResult = z.infer<typeof TransactionResultSchema>;

export const ListPlayerTransactionsArgs = PageQuerySchema.extend({
  userId: UuidSchema,
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
  // Crypto rail only - the address funds are sent to, and the on-chain reference once
  // settled. Both null for a fiat withdrawal (the PSP resolves its own payout destination).
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
    .input(PageQuerySchema)
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

  deposits: {
    getAddress: oc
      .route({ method: 'POST', path: '/wallet/deposits/address' })
      .input(DepositAddressInputSchema)
      .output(DepositAddressSchema),
  },

  // M2M payment-vendor webhook - no admin session.
  webhook: oc
    .route({ method: 'POST', path: '/wallet/webhook' })
    .input(PaymentWebhookInputSchema)
    .output(PaymentWebhookOutputSchema),
};
