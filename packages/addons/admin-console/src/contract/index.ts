import { oc } from '@orpc/contract';
import * as z from 'zod';
import { UserIdInputSchema } from '@oss/shared-schemas';

export const PlatformStatsSchema = z.object({
  totalUsers: z.number().int(),
  activeUsers: z.number().int(),
  totalDeposits: z.number(),
  totalWithdrawals: z.number(),
  totalBonusClaimed: z.number(),
});

export const AdminUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  createdAt: z.string(),
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
  createdAt: z.string(),
});

// Query params arrive as strings over HTTP - coerce so list endpoints validate.
const PaginationInputSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const backofficeContract = {
  getStats: oc.route({ method: 'GET', path: '/backoffice/stats' }).output(PlatformStatsSchema),

  listUsers: oc
    .route({ method: 'GET', path: '/backoffice/users' })
    .input(PaginationInputSchema.extend({ search: z.string().optional() }))
    .output(z.object({ users: z.array(AdminUserSchema), total: z.number().int() })),

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
        role: z.string().optional(),
      }),
    )
    .output(AdminUserSchema),

  listTransactions: oc
    .route({ method: 'GET', path: '/backoffice/transactions' })
    .input(PaginationInputSchema.extend({ userId: z.uuid().optional() }))
    .output(z.object({ transactions: z.array(AdminTransactionSchema), total: z.number().int() })),
};
