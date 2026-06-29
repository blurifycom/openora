import { z } from 'zod';
import {
  WalletBalanceSchema,
  WalletTransactionSchema,
  DepositInputSchema,
  WithdrawInputSchema,
  TransactionResultSchema,
  WithdrawalQueueItemSchema,
  WithdrawalQueueFilterSchema,
  ApproveWithdrawalInputSchema,
  RejectWithdrawalInputSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '../contract/index.js';

export {
  WalletBalanceSchema,
  WalletTransactionSchema,
  DepositInputSchema,
  WithdrawInputSchema,
  TransactionResultSchema,
  WithdrawalQueueItemSchema,
  WithdrawalQueueFilterSchema,
  ApproveWithdrawalInputSchema,
  RejectWithdrawalInputSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
  walletContract,
} from '../contract/index.js';

export type WalletBalance = z.infer<typeof WalletBalanceSchema>;
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;
export type DepositInput = z.infer<typeof DepositInputSchema>;
export type WithdrawInput = z.infer<typeof WithdrawInputSchema>;
export type TransactionResult = z.infer<typeof TransactionResultSchema>;
export type WithdrawalQueueItem = z.infer<typeof WithdrawalQueueItemSchema>;
export type WithdrawalQueueFilter = z.infer<typeof WithdrawalQueueFilterSchema>;
export type ApproveWithdrawalInput = z.infer<typeof ApproveWithdrawalInputSchema>;
export type RejectWithdrawalInput = z.infer<typeof RejectWithdrawalInputSchema>;
export type WalletRail = z.infer<typeof WalletRailSchema>;
export type WalletTransactionStatus = z.infer<typeof WalletTransactionStatusSchema>;
export type WalletTransactionType = z.infer<typeof WalletTransactionTypeSchema>;
