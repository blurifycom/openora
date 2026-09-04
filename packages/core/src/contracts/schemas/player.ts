import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { CountryCodeSchema, CurrencyCodeSchema } from './igaming-config.js';
import { E164PhoneSchema } from './identity.js';
import { TagKeySchema } from './tag.js';
import { PageQuerySchema, SortOrderSchema } from '../kit.js';

export const PLAYER_STATUSES = [
  'active',
  'dormant',
  'self_excluded',
  'suspended',
  'closed',
] as const;
export const PlayerStatusSchema = z.enum(PLAYER_STATUSES);

export const KYC_STATUSES = [
  'not_started',
  'pending',
  'approved',
  'verified',
  'rejected',
  'resubmission_requested',
  'manually_overridden',
] as const;
export const KycStatusSchema = z.enum(KYC_STATUSES);

export const KYC_TIERS = ['basic', 'advanced'] as const;
export const KycTierSchema = z.enum(KYC_TIERS);
export type KycTier = z.infer<typeof KycTierSchema>;

export const KYC_STATUS_SOURCES = ['vendor', 'manual', 'webhook', 'reverify'] as const;
export const KycStatusSourceSchema = z.enum(KYC_STATUS_SOURCES);
export type KycStatusSource = z.infer<typeof KycStatusSourceSchema>;

/**
 * Normalizes the deprecated `verified` value to the canonical `approved`. All new
 * writes produce `approved`; any read of a KYC status must go through this before
 * comparing, so a legacy row (or an in-flight old ECS task still writing `verified`
 * during a rolling deploy) is treated identically to a fresh `approved` one. Use this
 * everywhere a KYC status is checked for the approved state - never a scattered
 * `=== 'verified' || === 'approved'`.
 */
export function normalizeKycStatus(status: KycStatus): KycStatus {
  return status === 'verified' ? 'approved' : status;
}

export const PlayerSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  username: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  dateOfBirth: z.iso.date().nullable(),
  phone: z.string().nullable(),
  country: z.string().nullable(),
  currency: CurrencyCodeSchema,
  status: PlayerStatusSchema,
  kycStatus: KycStatusSchema,
  level: z.number().int(),
  totalWagered: MoneyAmountSchema,
  totalDeposits: MoneyAmountSchema,
  lastSeenAt: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const PlayerSearchArgsSchema = z.object({
  search: z.string().optional(),
  status: PlayerStatusSchema.optional(),
  kycStatus: KycStatusSchema.optional(),
  tags: z.array(TagKeySchema).optional(),
});

export const PLAYER_SORT_BY_VALUES = [
  'createdAt',
  'username',
  'status',
  'kycStatus',
  'totalWagered',
  'totalDeposits',
  'lastSeenAt',
  'level',
] as const;
export const PlayerSortBySchema = z.enum(PLAYER_SORT_BY_VALUES).default('createdAt');
export type PlayerSortBy = z.infer<typeof PlayerSortBySchema>;

export const PaginatedPlayerSearchArgsSchema = z.object({
  ...PlayerSearchArgsSchema.shape,
  ...PageQuerySchema.shape,
  sortBy: PlayerSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
});

export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;

export type PaginatedPlayerListSearchArgs = z.infer<typeof PaginatedPlayerSearchArgsSchema>;

export const MIN_PLAYER_AGE_YEARS = 18;

/**
 * Compares calendar dates, not elapsed milliseconds: a leap day between the birth date
 * and the cutoff would shift a ms-based boundary by a day. The player's own 18th birthday
 * passes.
 */
export function isAdultDateOfBirth(dateOfBirth: string, now = new Date()): boolean {
  const cutoff =
    (now.getUTCFullYear() - MIN_PLAYER_AGE_YEARS) * 10_000 +
    (now.getUTCMonth() + 1) * 100 +
    now.getUTCDate();
  return Number(dateOfBirth.replaceAll('-', '')) <= cutoff;
}

/**
 * Deliberately narrower than `PlayerSchema`: the read side stays tolerant of rows written
 * before these columns existed, while a write is held to ISO country codes and E.164
 * phones. `null` clears a field; omitting it leaves the stored value alone. `phone` is the
 * player's self-declared contact number - the verified login credential lives on the
 * identity module's `user.phoneNumber` and is never written from here.
 */
export const UpdatePlayerProfileInputSchema = z
  .object({
    firstName: z.string().min(1).max(100).nullable(),
    lastName: z.string().min(1).max(100).nullable(),
    dateOfBirth: z.iso
      .date()
      .refine((value) => isAdultDateOfBirth(value), {
        message: `Player must be at least ${MIN_PLAYER_AGE_YEARS} years old`,
      })
      .nullable(),
    phone: E164PhoneSchema.nullable(),
    country: CountryCodeSchema.nullable(),
    currency: CurrencyCodeSchema,
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
