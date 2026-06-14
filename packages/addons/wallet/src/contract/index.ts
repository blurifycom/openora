import { oc } from '@orpc/contract';
import * as z from 'zod';

export const WalletBalanceSchema = z.object({
  balance: z.number(),
  currency: z.string(),
  tenantId: z.string(),
});

export const WalletTransactionSchema = z.object({
  id: z.string(),
  type: z.enum(['deposit', 'withdrawal', 'bet', 'win']),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  createdAt: z.string(),
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
  transactionId: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
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
};
