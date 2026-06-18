// Shared player schemas the player-management add-on derives from. See ADR-0021.
import * as z from 'zod';

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
  userId: z.uuid(),
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
  createdAt: z.iso.datetime(),
  updatedAt: z.string(),
});

export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;

// Lives in contracts (not pam profile) so the SDK can import it without violating
// no-core-to-domain. The profile contract re-imports it from here.
export const UpdatePlayerProfileInputSchema = PlayerSchema.pick({
  displayName: true,
  country: true,
  currency: true,
  language: true,
}).partial();

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
