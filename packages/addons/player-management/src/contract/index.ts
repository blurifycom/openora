import { oc, populateContractRouterPaths } from '@orpc/contract';
import * as z from 'zod';
// The canonical player shape + lifecycle/KYC enums are cross-cutting (the free
// profile add-on derives from them too), so they live in shared-schemas. See ADR-0021.
import { PlayerSchema, PlayerStatusSchema, KycStatusSchema } from '@oss/shared-schemas';

export { PlayerSchema, PlayerStatusSchema, KycStatusSchema };

/** One bucket of the registrations-over-time chart. */
export const PlayerRegistrationPointSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  count: z.number().int(),
});

/** Headline numbers for the players dashboard. */
export const PlayerSummarySchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  newLastWeek: z.number().int(),
  selfExcluded: z.number().int(),
});

const PaginationInputSchema = z.object({
  // Query params arrive as strings over HTTP - coerce so both the typed client
  // (sends numbers) and raw REST/OpenAPI consumers (send strings) validate.
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Player Account Management (PAM) contract - the admin-facing surface for managing
 * igaming players. Add-on: lives here, not in the core root contract. Populated so
 * the router implements against it and the app merges it as-is.
 */
export const playerContract = populateContractRouterPaths({
  list: oc
    .route({ method: 'GET', path: '/players' })
    .input(
      PaginationInputSchema.extend({
        search: z.string().optional(),
        status: PlayerStatusSchema.optional(),
      }),
    )
    .output(z.object({ players: z.array(PlayerSchema), total: z.number().int() })),

  get: oc
    .route({ method: 'GET', path: '/players/{playerId}' })
    .input(z.object({ playerId: z.uuid() }))
    .output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/players/{playerId}' })
    .input(
      z.object({
        playerId: z.uuid(),
        displayName: z.string().min(1).max(120).optional(),
        status: PlayerStatusSchema.optional(),
        kycStatus: KycStatusSchema.optional(),
        level: z.number().int().min(0).max(100).optional(),
      }),
    )
    .output(PlayerSchema),

  remove: oc
    .route({ method: 'DELETE', path: '/players/{playerId}' })
    .input(z.object({ playerId: z.uuid() }))
    .output(z.object({ success: z.boolean() })),

  registrationsOverTime: oc
    .route({ method: 'GET', path: '/players/stats/registrations' })
    .input(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }))
    .output(z.array(PlayerRegistrationPointSchema)),

  summary: oc.route({ method: 'GET', path: '/players/stats/summary' }).output(PlayerSummarySchema),
});
