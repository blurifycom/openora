import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  KycStatusSchema,
  UuidSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

export { WalletRailSchema, WalletTransactionStatusSchema, WalletTransactionTypeSchema };

export const WalletBalanceSchema = z.object({
  balance: z.number(),
  currency: z.string(),
});

export const WalletTransactionSchema = z.object({
  id: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: z.number(),
  currency: z.string(),
  status: WalletTransactionStatusSchema,
  createdAt: z.iso.datetime(),
});

export const DepositInputSchema = z.object({
  amount: z.number().positive(),
  currency: z.string(),
  provider: z.string().optional(),
});

export const WithdrawInputSchema = z.object({
  amount: z.number().positive(),
  currency: z.string(),
  provider: z.string().optional(),
});

export const TransactionResultSchema = z.object({
  transactionId: UuidSchema,
  status: WalletTransactionStatusSchema,
});

export const WithdrawalQueueItemSchema = z.object({
  transactionId: UuidSchema,
  userId: UuidSchema,
  username: z.string(),
  amount: z.number(),
  currency: z.string(),
  rail: WalletRailSchema.nullable(),
  status: WalletTransactionStatusSchema,
  kycStatus: KycStatusSchema.nullable(),
  riskTags: z.array(z.string()),
  requestedAt: z.iso.datetime(),
});

export const WithdrawalQueueFilterSchema = PageQuerySchema.extend({
  currency: z.string().optional(),
  rail: WalletRailSchema.optional(),
  minAmount: z.coerce.number().nonnegative().optional(),
  maxAmount: z.coerce.number().nonnegative().optional(),
  kycStatus: KycStatusSchema.optional(),
  dateFrom: z.iso.datetime().optional(),
  dateTo: z.iso.datetime().optional(),
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
    .output(z.array(WalletTransactionSchema)),

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
