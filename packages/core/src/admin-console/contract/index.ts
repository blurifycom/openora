import { oc } from '@orpc/contract';
import * as z from 'zod';
import { UserIdInputSchema } from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

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
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
  isActive: z.boolean(),
  role: z.string(),
});

export const AdminTransactionSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  type: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.iso.datetime(),
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
        userId: z.uuid(),
        isActive: z.boolean().optional(),
        role: UserRoleSchema.optional(),
      }),
    )
    .output(AdminUserSchema),

  listTransactions: oc
    .route({ method: 'GET', path: '/backoffice/transactions' })
    .input(PageQuerySchema.extend({ userId: z.uuid().optional() }))
    .output(paginated(AdminTransactionSchema)),
};
