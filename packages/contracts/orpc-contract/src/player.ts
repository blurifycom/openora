import * as z from 'zod';

/**
 * The canonical igaming `player` shape + lifecycle / KYC enums. Shared by the core
 * player-facing profile surface (profileContract) and the add-on admin PAM package
 * (@oss-addons/player-management), which imports these from here.
 *
 * The admin PAM route contract (list/get/update/remove/stats) is NOT here - it moved
 * to the add-on package so the default build's root contract carries no PAM surface.
 * See ADR-0020.
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
