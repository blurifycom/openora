import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  KycStatusSchema,
  TimestampSchema,
  UserIdInputSchema,
  UserRoleSchema,
  UuidSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

export const PlayerEmailSchema = z.email();
export const PlayerUsernameSchema = z.string();
export const PlayerSearchSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe('Free-text filter matched against player email or username');

export const PlatformStatsSchema = z.object({
  totalUsers: z.number().int(),
  activeUsers: z.number().int(),
  totalDeposits: z.number(),
  totalWithdrawals: z.number(),
  totalBonusClaimed: z.number(),
});

export { UserRoleSchema } from '@blurifycom/core/contracts';

export const AdminUserSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string().nullable(),
  createdAt: TimestampSchema,
  isActive: z.boolean(),
  role: UserRoleSchema,
  failedLoginAttempts: z.number().int().optional(),
  lockoutUntil: TimestampSchema.nullable().optional(),
});

export const TransactionFilterSchema = PageQuerySchema.extend({
  userId: UuidSchema.optional(),
  type: WalletTransactionTypeSchema.optional(),
  currency: CurrencyCodeSchema.optional(),
  rail: WalletRailSchema.optional(),
  status: WalletTransactionStatusSchema.optional(),
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
  amountMin: z.number().nonnegative().optional(),
  amountMax: z.number().nonnegative().optional(),
  player: PlayerSearchSchema.optional(),
});

// The list row carries only the player email as the identifying label; the fuller
// player info (username, KYC) lives on the detail view fetched on "view".
export const AdminTransactionSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: z.number(),
  currency: CurrencyCodeSchema,
  status: WalletTransactionStatusSchema,
  rail: WalletRailSchema.nullable(),
  playerEmail: PlayerEmailSchema.nullable(),
  createdAt: TimestampSchema,
});

export const AdminTransactionDetailSchema = AdminTransactionSchema.extend({
  playerUsername: PlayerUsernameSchema.nullable(),
  playerKycStatus: KycStatusSchema.nullable(),
  providerRefId: z.string().nullable(),
  providerName: z.string().nullable(),
  reviewedBy: UuidSchema.nullable(),
  reviewedAt: TimestampSchema.nullable(),
  reviewReason: z.string().nullable(),
});

export const backofficeContract = {
  getStats: oc.route({ method: 'GET', path: '/backoffice/stats' }).output(PlatformStatsSchema),

  listUsers: oc
    .route({ method: 'GET', path: '/backoffice/users' })
    .input(PageQuerySchema.extend({ search: z.string().optional() }))
    .output(paginated(AdminUserSchema)),

  getUser: oc
    .route({ method: 'GET', path: '/backoffice/users/{userId}' })
    .input(UserIdInputSchema)
    .output(AdminUserSchema),

  updateUser: oc
    .route({ method: 'PATCH', path: '/backoffice/users/{userId}' })
    .input(
      z.object({
        userId: UuidSchema,
        isActive: z.boolean().optional(),
        role: UserRoleSchema.optional(),
      }),
    )
    .output(AdminUserSchema),

  listTransactions: oc
    .route({ method: 'GET', path: '/backoffice/transactions' })
    .input(TransactionFilterSchema)
    .output(paginated(AdminTransactionSchema)),

  getTransaction: oc
    .route({ method: 'GET', path: '/backoffice/transactions/{id}' })
    .input(z.object({ id: UuidSchema }))
    .output(AdminTransactionDetailSchema),
};

export type TransactionFilter = z.infer<typeof TransactionFilterSchema>;
