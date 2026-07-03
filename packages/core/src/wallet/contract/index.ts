import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  KycStatusSchema,
  TimestampSchema,
  UuidSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

export { WalletRailSchema, WalletTransactionStatusSchema, WalletTransactionTypeSchema };

export const WalletBalanceSchema = z.object({
  balance: z.number(),
  currency: CurrencyCodeSchema,
});

export const WalletTransactionSchema = z.object({
  id: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: z.number(),
  currency: CurrencyCodeSchema,
  status: WalletTransactionStatusSchema,
  createdAt: TimestampSchema,
});

export const DepositInputSchema = z.object({
  amount: z.number().positive(),
  currency: CurrencyCodeSchema,
  provider: z.string().optional(),
});

export const WithdrawInputSchema = z.object({
  amount: z.number().positive(),
  currency: CurrencyCodeSchema,
  provider: z.string().optional(),
});

export const TransactionResultSchema = z.object({
  transactionId: UuidSchema,
  status: WalletTransactionStatusSchema,
});

export const ListPlayerTransactionsArgs = PageQuerySchema.extend({
  userId: UuidSchema,
});

export const WithdrawalQueueItemSchema = z.object({
  transactionId: UuidSchema,
  userId: UuidSchema,
  username: z.string(),
  amount: z.number(),
  currency: CurrencyCodeSchema,
  rail: WalletRailSchema.nullable(),
  status: WalletTransactionStatusSchema,
  kycStatus: KycStatusSchema.nullable(),
  riskTags: z.array(z.string()),
  requestedAt: TimestampSchema,
});

export const WithdrawalQueueFilterSchema = PageQuerySchema.extend({
  currency: CurrencyCodeSchema.optional(),
  rail: WalletRailSchema.optional(),
  minAmount: z.coerce.number().nonnegative().optional(),
  maxAmount: z.coerce.number().nonnegative().optional(),
  kycStatus: KycStatusSchema.optional(),
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
});

export const ApproveWithdrawalInputSchema = z.object({ withdrawalId: UuidSchema });

export const RejectWithdrawalInputSchema = z.object({
  withdrawalId: UuidSchema,
  reason: z.string().min(1),
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
};
