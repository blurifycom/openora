import { oc, populateContractRouterPaths } from '@orpc/contract';
import * as z from 'zod';
import {
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  UuidSchema,
  TagKeySchema,
  PaginatedPlayerSearchArgsSchema,
  MoneyAmountSchema,
  UsernameSchema,
  AccountManagerSchema,
} from '@openora/core/contracts';
import { paginated } from '@openora/core/contracts/kit';

export { PlayerSchema, PlayerStatusSchema, KycStatusSchema };
export * from './agent-tools.js';

export const PlayerWithTagsSchema = PlayerSchema.extend({
  tags: z.array(TagKeySchema),
  accountManager: AccountManagerSchema.nullable(),
});
export type PlayerWithTags = z.infer<typeof PlayerWithTagsSchema>;

export const PlayerRegistrationPointSchema = z.object({
  date: z.string(),
  count: z.number().int(),
});

export const PlayerSummarySchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  newLastWeek: z.number().int(),
  selfExcluded: z.number().int(),
});

export const PlayerSearchResultSchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
});
export type PlayerSearchResult = z.infer<typeof PlayerSearchResultSchema>;

export const PlayerProfileCardSchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
  joinedAt: z.string().nullable(),
  totalWagered: MoneyAmountSchema.nullable(),
  totalBets: z.number().int().nullable(),
  currency: z.string().nullable(),
});
export type PlayerProfileCard = z.infer<typeof PlayerProfileCardSchema>;

export const AssignedAccountManagerSchema = AccountManagerSchema.extend({ email: z.string() });
export type AssignedAccountManager = z.infer<typeof AssignedAccountManagerSchema>;

export const AccountManagerCandidateSchema = AssignedAccountManagerSchema.omit({ isActive: true });
export type AccountManagerCandidate = z.infer<typeof AccountManagerCandidateSchema>;

export const playerContract = populateContractRouterPaths({
  list: oc
    .route({ method: 'GET', path: '/players' })
    .input(PaginatedPlayerSearchArgsSchema)
    .output(paginated(PlayerWithTagsSchema)),

  get: oc
    .route({ method: 'GET', path: '/players/{playerId}' })
    .input(
      z.object({
        playerId: UuidSchema,
      }),
    )
    .output(PlayerWithTagsSchema),

  getByUserId: oc
    .route({ method: 'GET', path: '/players/by-user/{userId}' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/players/{playerId}' })
    .input(
      z.object({
        playerId: UuidSchema,
        username: UsernameSchema.optional(),
        status: PlayerStatusSchema.optional(),
        level: z.number().int().min(0).max(100).optional(),
      }),
    )
    .output(PlayerWithTagsSchema),

  setAccountManager: oc
    .route({ method: 'PUT', path: '/players/{playerId}/account-manager' })
    .input(z.object({ playerId: UuidSchema, accountManagerId: UuidSchema.nullable() }))
    .output(z.object({ accountManager: AccountManagerSchema.nullable() })),

  accountManagerCandidates: oc
    .route({ method: 'GET', path: '/players/account-managers' })
    .input(
      z.object({
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    )
    .output(z.array(AccountManagerCandidateSchema)),

  assignedAccountManagers: oc
    .route({ method: 'GET', path: '/players/account-managers/assigned' })
    .output(z.array(AssignedAccountManagerSchema)),

  remove: oc
    .route({ method: 'DELETE', path: '/players/{playerId}' })
    .input(z.object({ playerId: UuidSchema }))
    .output(z.object({ success: z.boolean() })),

  registrationsOverTime: oc
    .route({ method: 'GET', path: '/players/stats/registrations' })
    .input(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }))
    .output(z.array(PlayerRegistrationPointSchema)),

  summary: oc.route({ method: 'GET', path: '/players/stats/summary' }).output(PlayerSummarySchema),

  playerSearch: oc
    .route({ method: 'GET', path: '/players/search' })
    .input(
      z.object({
        q: z.string().min(1).max(50),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    )
    .output(z.array(PlayerSearchResultSchema)),

  playerProfile: oc
    .route({ method: 'GET', path: '/players/{userId}/profile-card' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerProfileCardSchema),
});
