import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  ADMIN_TX_SORT_BY_VALUES,
  ADMIN_USER_SORT_BY_VALUES,
  CurrencyCodeSchema,
  GAME_PERFORMANCE_SORT_FIELDS,
  GameTypeSchema,
  IdInputSchema,
  KycStatusSchema,
  MoneyAmountSchema,
  SignedMoneyAmountSchema,
  TimestampSchema,
  UserIdInputSchema,
  UserRoleSchema,
  UuidSchema,
  WalletRailSchema,
  WalletTransactionStatusSchema,
  WalletTransactionTypeSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

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
  totalDeposits: MoneyAmountSchema,
  totalWithdrawals: MoneyAmountSchema,
  totalBonusClaimed: MoneyAmountSchema,
});

export { UserRoleSchema } from '@openora/core/contracts';

export const AdminUserSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string().nullable(),
  createdAt: TimestampSchema,
  isActive: z.boolean(),
  role: z.string().min(1),
  failedLoginAttempts: z.number().int().optional(),
  lockoutUntil: TimestampSchema.nullable().optional(),
  assignedRoles: z.array(z.object({ roleId: UuidSchema, roleName: z.string() })),
});

export const AdminUserSortBySchema = z.enum(ADMIN_USER_SORT_BY_VALUES).default('createdAt');
export type AdminUserSortBy = z.infer<typeof AdminUserSortBySchema>;

export const AdminTransactionSortBySchema = z.enum(ADMIN_TX_SORT_BY_VALUES).default('createdAt');
export type AdminTransactionSortBy = z.infer<typeof AdminTransactionSortBySchema>;

export const TransactionFilterSchema = PageQuerySchema.extend({
  userId: UuidSchema.optional(),
  type: WalletTransactionTypeSchema.optional(),
  currency: CurrencyCodeSchema.optional(),
  rail: WalletRailSchema.optional(),
  status: WalletTransactionStatusSchema.optional(),
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
  amountMin: MoneyAmountSchema.optional(),
  amountMax: MoneyAmountSchema.optional(),
  player: PlayerSearchSchema.optional(),
  sortBy: AdminTransactionSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});

// The list row carries the playerId and player email as the identifying labels;
// the fuller player info (username, KYC) lives on the detail view fetched on "view".
export const AdminTransactionSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  type: WalletTransactionTypeSchema,
  amount: MoneyAmountSchema,
  currency: CurrencyCodeSchema,
  status: WalletTransactionStatusSchema,
  rail: WalletRailSchema.nullable(),
  playerId: UuidSchema.nullable(),
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

export const GamePerformanceSortBySchema = z.enum(GAME_PERFORMANCE_SORT_FIELDS);
export const SortDirectionSchema = z.enum(['asc', 'desc']);

export const GamePerformanceFilterSchema = z.object({
  gameType: GameTypeSchema.optional(),
  currency: CurrencyCodeSchema.optional(),
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
  sortBy: GamePerformanceSortBySchema.optional(),
  sortDir: SortDirectionSchema.optional(),
});

// `revenue` (GGR = volume - payouts) uses the signed variant - it legitimately goes
// negative over a short/unlucky-for-the-house window.
export const GamePerformanceSchema = z.object({
  gameId: UuidSchema,
  name: z.string(),
  gameType: GameTypeSchema,
  volume: MoneyAmountSchema,
  revenue: SignedMoneyAmountSchema,
  uniquePlayers: z.number().int(),
  roundsPlayed: z.number().int(),
});

export const PlayerActivityFilterSchema = z.object({
  dateFrom: TimestampSchema.optional(),
  dateTo: TimestampSchema.optional(),
});

export const RegistrationsOverTimePointSchema = z.object({
  date: z.iso.date(),
  registrations: z.number().int(),
});

export const ActiveUsersTrendPointSchema = z.object({
  date: z.iso.date(),
  dau: z.number().int(),
  wau: z.number().int(),
  mau: z.number().int(),
});

export const RetentionCohortRowSchema = z.object({
  cohortDate: z.iso.date(),
  cohortSize: z.number().int(),
  returned: z.number().int(),
  returnRate: z.number(),
  isComplete: z.boolean(),
});

export const PlayerActivitySchema = z.object({
  registrationsOverTime: z.array(RegistrationsOverTimePointSchema),
  activeUsersTrend: z.array(ActiveUsersTrendPointSchema),
  retention: z.object({
    sevenDay: z.array(RetentionCohortRowSchema),
    thirtyDay: z.array(RetentionCohortRowSchema),
  }),
});

export const backofficeContract = {
  getStats: oc.route({ method: 'GET', path: '/backoffice/stats' }).output(PlatformStatsSchema),

  listUsers: oc
    .route({ method: 'GET', path: '/backoffice/users' })
    .input(
      PageQuerySchema.extend({
        search: z.string().optional(),
        sortBy: AdminUserSortBySchema.optional(),
        sortOrder: SortOrderSchema.default('desc').optional(),
      }),
    )
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
    .input(IdInputSchema)
    .output(AdminTransactionDetailSchema),

  getGamePerformance: oc
    .route({ method: 'GET', path: '/backoffice/analytics/games' })
    .input(GamePerformanceFilterSchema)
    .output(z.array(GamePerformanceSchema)),

  getPlayerActivity: oc
    .route({ method: 'GET', path: '/backoffice/analytics/players' })
    .input(PlayerActivityFilterSchema)
    .output(PlayerActivitySchema),
};

export type TransactionFilter = z.infer<typeof TransactionFilterSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type GamePerformanceFilter = z.infer<typeof GamePerformanceFilterSchema>;
export type GamePerformance = z.infer<typeof GamePerformanceSchema>;
export type PlayerActivityFilter = z.infer<typeof PlayerActivityFilterSchema>;
export type PlayerActivity = z.infer<typeof PlayerActivitySchema>;
