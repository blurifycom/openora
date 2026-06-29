import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  CurrencyCodeSchema,
  KycStatusSchema,
  UserIdInputSchema,
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

// Closed set of values the `user.role` column legitimately holds. `admin` is the
// super-admin bootstrap role (IamService.isSuperAdmin), so writing it is gated to
// super-admins in the router; arbitrary strings must never reach the directory.
export const UserRoleSchema = z.enum(['player', 'admin']);

export const AdminUserSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
  isActive: z.boolean(),
  role: z.string(),
  failedLoginAttempts: z.number().int().optional(),
  lockoutUntil: z.iso.datetime().nullable().optional(),
});

export const TransactionFilterSchema = PageQuerySchema.extend({
  userId: UuidSchema.optional(),
  type: WalletTransactionTypeSchema.optional(),
  currency: CurrencyCodeSchema.optional(),
  rail: WalletRailSchema.optional(),
  status: WalletTransactionStatusSchema.optional(),
  dateFrom: z.iso.datetime().optional(),
  dateTo: z.iso.datetime().optional(),
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
  createdAt: z.iso.datetime(),
});

export const AdminTransactionDetailSchema = AdminTransactionSchema.extend({
  playerUsername: PlayerUsernameSchema.nullable(),
  playerKycStatus: KycStatusSchema.nullable(),
  providerRefId: z.string().nullable(),
  providerName: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
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
