import { oc } from '@orpc/contract';
import * as z from 'zod';

/**
 * Player Account Management (PAM) contract - the admin-facing surface for
 * managing casino players. igaming-standard lifecycle + KYC states.
 */

export const PlayerStatusSchema = z.enum([
  'active',
  'dormant',
  'self_excluded',
  'suspended',
  'closed',
]);

export const KycStatusSchema = z.enum(['pending', 'verified', 'rejected']);

export const PlayerSchema = z.object({
  id: z.string(),
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  country: z.string().nullable(),
  currency: z.string(),
  language: z.string(),
  status: PlayerStatusSchema,
  kycStatus: KycStatusSchema,
  level: z.number().int(),
  totalWagered: z.number(),
  totalDeposits: z.number(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

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

export const playerContract = {
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
    .input(z.object({ playerId: z.string() }))
    .output(PlayerSchema),

  update: oc
    .route({ method: 'PATCH', path: '/players/{playerId}' })
    .input(
      z.object({
        playerId: z.string(),
        displayName: z.string().min(1).max(120).optional(),
        status: PlayerStatusSchema.optional(),
        kycStatus: KycStatusSchema.optional(),
        level: z.number().int().min(0).max(100).optional(),
      }),
    )
    .output(PlayerSchema),

  remove: oc
    .route({ method: 'DELETE', path: '/players/{playerId}' })
    .input(z.object({ playerId: z.string() }))
    .output(z.object({ success: z.boolean() })),

  registrationsOverTime: oc
    .route({ method: 'GET', path: '/players/stats/registrations' })
    .input(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }))
    .output(z.array(PlayerRegistrationPointSchema)),

  summary: oc.route({ method: 'GET', path: '/players/stats/summary' }).output(PlayerSummarySchema),
};
