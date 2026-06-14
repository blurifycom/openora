import {
  PlatformStatsSchema,
  AdminUserSchema,
  AdminTransactionSchema,
} from '../contract/index.js';
import type { z } from 'zod';

export { PlatformStatsSchema, AdminUserSchema, AdminTransactionSchema };

export type PlatformStats = z.infer<typeof PlatformStatsSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminTransaction = z.infer<typeof AdminTransactionSchema>;
