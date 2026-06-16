import * as z from 'zod';

/**
 * The canonical igaming `player` shape + lifecycle / KYC enums. Shared across
 * add-ons: the player-facing profile surface (@oss/pam profile) and the admin
 * PAM add-on (@oss/pam player-management) both derive from this one shape.
 *
 * It lives in shared-schemas (not in either add-on's contract) precisely because
 * more than one add-on needs it - the cross-cutting rule. The admin PAM route
 * contract (list/get/update/remove/stats) is NOT here; it lives in the
 * player-management add-on. See ADR-0021.
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

// The editable subset of the self-profile (display name, country, display
// currency, language), all optional. Derived from PlayerSchema so no field
// shapes are re-typed. Lives here (not in the pam profile contract) so the
// frontend SDK can reference the input shape without importing a domain package
// - foundation may import contracts/shared-schemas but never a domain (the
// no-core-to-domain boundary). The profile contract imports it back from here.
export const UpdatePlayerProfileInputSchema = PlayerSchema.pick({
  displayName: true,
  country: true,
  currency: true,
  language: true,
}).partial();

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
