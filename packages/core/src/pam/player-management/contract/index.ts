// Shared so the profile module can derive from them too. See ADR-0021.
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
} from '@openora/core/contracts';
import { paginated } from '@openora/core/contracts/kit';

export { PlayerSchema, PlayerStatusSchema, KycStatusSchema };

/** Player row enriched with their active tags - used only by the admin list endpoint. */
export const PlayerWithTagsSchema = PlayerSchema.extend({
  tags: z.array(TagKeySchema),
});
export type PlayerWithTags = z.infer<typeof PlayerWithTagsSchema>;

export const PlayerRegistrationPointSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  count: z.number().int(),
});

export const PlayerSummarySchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  newLastWeek: z.number().int(),
  selfExcluded: z.number().int(),
});

// Ported from chat-commands: powers the chat `/profile` command's search step
// and profile card. See AGENTS.md "block/ignore search exclusion".
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

  // Resolve a player by their identity userId - the id every other module (compliance
  // RG flags, audit, wallet) carries, since none of them know the PAM playerId.
  getByUserId: oc
    .route({ method: 'GET', path: '/players/by-user/{userId}' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/players/{playerId}' })
    .input(
      z.object({
        playerId: UuidSchema,
        displayName: z.string().min(1).max(120).optional(),
        status: PlayerStatusSchema.optional(),
        level: z.number().int().min(0).max(100).optional(),
        email: z.email().optional(),
      }),
    )
    .output(PlayerWithTagsSchema),

  remove: oc
    .route({ method: 'DELETE', path: '/players/{playerId}' })
    .input(z.object({ playerId: UuidSchema }))
    .output(z.object({ success: z.boolean() })),

  registrationsOverTime: oc
    .route({ method: 'GET', path: '/players/stats/registrations' })
    .input(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }))
    .output(z.array(PlayerRegistrationPointSchema)),

  summary: oc.route({ method: 'GET', path: '/players/stats/summary' }).output(PlayerSummarySchema),

  // Chat `/profile` command's search step - excludes players the caller has
  // blocked/ignored (moderation). See AGENTS.md.
  playerSearch: oc
    .route({ method: 'GET', path: '/players/search' })
    .input(
      z.object({
        q: z.string().min(1).max(50),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    )
    .output(z.array(PlayerSearchResultSchema)),

  // Looked up by identity userId (like getByUserId), never the PAM playerId.
  playerProfile: oc
    .route({ method: 'GET', path: '/players/{userId}/profile-card' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerProfileCardSchema),
});
