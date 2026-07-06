// Shared so the profile add-on can derive from them too. See ADR-0021.
import { oc, populateContractRouterPaths } from '@orpc/contract';
import * as z from 'zod';
import {
  PlayerSchema,
  PlayerStatusSchema,
  KycStatusSchema,
  UuidSchema,
} from '@blurifycom/core/contracts';
import { PageQuerySchema, paginated } from '@blurifycom/core/contracts/kit';

export { PlayerSchema, PlayerStatusSchema, KycStatusSchema };

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
    .input(
      PageQuerySchema.extend({
        search: z.string().optional(),
        status: PlayerStatusSchema.optional(),
        kycStatus: KycStatusSchema.optional(),
      }),
    )
    .output(paginated(PlayerSchema)),

  get: oc
    .route({ method: 'GET', path: '/players/{playerId}' })
    .input(
      z.object({
        playerId: UuidSchema,
      }),
    )
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
    .output(PlayerSchema),

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
