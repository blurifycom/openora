import { z } from 'zod';
import {
  WalletBalanceSchema,
  WalletTransactionSchema,
  DepositInputSchema,
  WithdrawInputSchema,
  TransactionResultSchema,
} from '../contract/index.js';

export {
  WalletBalanceSchema,
  WalletTransactionSchema,
  DepositInputSchema,
  WithdrawInputSchema,
  TransactionResultSchema,
  walletContract,
} from '../contract/index.js';

export type WalletBalance = z.infer<typeof WalletBalanceSchema>;
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;
export type DepositInput = z.infer<typeof DepositInputSchema>;
export type WithdrawInput = z.infer<typeof WithdrawInputSchema>;
export type TransactionResult = z.infer<typeof TransactionResultSchema>;
