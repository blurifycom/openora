// Shared so the profile add-on can derive from them too. See ADR-0021.
import { oc, populateContractRouterPaths } from '@orpc/contract';
import * as z from 'zod';
import {
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  UuidSchema,
  TagKeySchema,
  PaginatedPlayerSearchArgsSchema,
} from '@blurifycom/core/contracts';
import { paginated } from '@blurifycom/core/contracts/kit';

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
        kycStatus: KycStatusSchema.optional(),
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
});
