import * as z from 'zod';
import {
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  TimestampSchema,
  TimezoneSchema,
  UuidSchema,
} from './common.js';
import { CountryCodeSchema } from './igaming-config.js';
import { E164PhoneSchema, UsernameSchema } from './identity.js';
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

export const KYC_STATUS_SOURCES = ['vendor', 'manual', 'webhook', 'reverify', 'exemption'] as const;
export const KycStatusSourceSchema = z.enum(KYC_STATUS_SOURCES);
export type KycStatusSource = z.infer<typeof KycStatusSourceSchema>;

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
  bio: z.string().nullable(),
  currency: CurrencyTickerSchema,
  status: PlayerStatusSchema,
  kycStatus: KycStatusSchema,
  level: z.number().int(),
  totalWagered: MoneyAmountSchema,
  totalDeposits: MoneyAmountSchema,
  lastSeenAt: z.string().nullable(),
  timezone: TimezoneSchema.nullable(),
  timezoneUpdatedAt: TimestampSchema.nullable(),
  hideUsernameOnLeaderboards: z.boolean(),
  allowFriendRequests: z.boolean(),
  showOnlineStatusToFriends: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const PlayerSearchArgsSchema = z.object({
  search: z.string().optional(),
  status: PlayerStatusSchema.optional(),
  kycStatus: KycStatusSchema.optional(),
  tags: z.array(TagKeySchema).optional(),
  accountManagerId: UuidSchema.optional(),
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

export const AccountManagerSchema = z.object({
  userId: UuidSchema,
  name: z.string(),
  isActive: z.boolean(),
});
export type AccountManager = z.infer<typeof AccountManagerSchema>;

export const ACCOUNT_MANAGER_INELIGIBLE_REASONS = ['unknown', 'inactive', 'not_eligible'] as const;
export const AccountManagerIneligibleReasonSchema = z.enum(ACCOUNT_MANAGER_INELIGIBLE_REASONS);
export type AccountManagerIneligibleReason = z.infer<typeof AccountManagerIneligibleReasonSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;

export type PaginatedPlayerListSearchArgs = z.infer<typeof PaginatedPlayerSearchArgsSchema>;

export const MIN_PLAYER_AGE_YEARS = 18;

export const PLAYER_BIO_MAX_LENGTH = 160;

const BIO_FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;
const ZERO_WIDTH_JOINER = /\u200D/g;

export const PlayerBioSchema = z
  .string()
  .trim()
  .max(PLAYER_BIO_MAX_LENGTH)
  .refine((value) => !BIO_FORBIDDEN_CHARS.test(value.replace(ZERO_WIDTH_JOINER, '')), {
    message: 'Bio must be plain text',
  })
  .transform((value) => value || null)
  .nullable();

export function isAdultDateOfBirth(
  dateOfBirth: string,
  now = new Date(),
  minAge = MIN_PLAYER_AGE_YEARS,
): boolean {
  const cutoff =
    (now.getUTCFullYear() - minAge) * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  return Number(dateOfBirth.replaceAll('-', '')) <= cutoff;
}

export const UpdatePlayerProfileInputSchema = z
  .object({
    firstName: z.string().min(1).max(100).nullable(),
    lastName: z.string().min(1).max(100).nullable(),
    dateOfBirth: z.iso.date().nullable(),
    phone: E164PhoneSchema.nullable(),
    country: CountryCodeSchema.nullable(),
    currency: CurrencyTickerInputSchema,
    timezone: TimezoneSchema,
    hideUsernameOnLeaderboards: z.boolean(),
    allowFriendRequests: z.boolean(),
    showOnlineStatusToFriends: z.boolean(),
    username: UsernameSchema,
    bio: PlayerBioSchema,
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update',
  });

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
