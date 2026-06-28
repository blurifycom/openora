import {
  PlatformStatsSchema,
  AdminUserSchema,
  AdminTransactionSchema,
  AdminTransactionDetailSchema,
  TransactionFilterSchema,
} from '../contract/index.js';
import type { z } from 'zod';

export {
  PlatformStatsSchema,
  AdminUserSchema,
  AdminTransactionSchema,
  AdminTransactionDetailSchema,
  TransactionFilterSchema,
};

export type PlatformStats = z.infer<typeof PlatformStatsSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminTransaction = z.infer<typeof AdminTransactionSchema>;
export type AdminTransactionDetail = z.infer<typeof AdminTransactionDetailSchema>;
export type TransactionFilter = z.infer<typeof TransactionFilterSchema>;
