// Shared player schemas the player-management add-on derives from. See ADR-0021.
import * as z from 'zod';
import { TimestampSchema, UuidSchema } from './common.js';
import { CurrencyCodeSchema } from './igaming-config.js';

export const PlayerStatusSchema = z.enum([
  'active',
  'dormant',
  'self_excluded',
  'suspended',
  'closed',
]);

// Additive expansion (no rename, no data migration): `not_started` precedes a first
// submission, `resubmission_requested` is set by a threshold-triggered re-KYC, and
// `manually_overridden` records an admin override. Vendor statuses stay separate
// (`KycVendorStatus`); the adapter maps vendor `approved` -> app `verified`.
export const KYC_STATUSES = [
  'not_started',
  'pending',
  'verified',
  'rejected',
  'resubmission_requested',
  'manually_overridden',
] as const;

export const KycStatusSchema = z.enum(KYC_STATUSES);

export const PlayerSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  displayName: z.string(),
  email: z.string(),
  country: z.string().nullable(),
  currency: CurrencyCodeSchema,
  language: z.string(),
  theme: z.string(),
  status: PlayerStatusSchema,
  kycStatus: KycStatusSchema,
  level: z.number().int(),
  totalWagered: z.number(),
  totalDeposits: z.number(),
  lastSeenAt: z.string().nullable(),
  createdAt: TimestampSchema,
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
  theme: true,
}).partial();

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
