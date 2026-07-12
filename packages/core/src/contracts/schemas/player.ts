import * as z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';
import { CurrencyCodeSchema } from './igaming-config.js';
import { TagKeySchema } from './tag.js';
import { PageQuerySchema } from '../kit.js';

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

export const PaginatedPlayerSearchArgsSchema = z.object({
  ...PlayerSearchArgsSchema.shape,
  ...PageQuerySchema.shape,
});

export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;

export type PaginatedPlayerListSearchArgs = z.infer<typeof PaginatedPlayerSearchArgsSchema>;

export const UpdatePlayerProfileInputSchema = PlayerSchema.pick({
  displayName: true,
  country: true,
  currency: true,
}).partial();

export type UpdatePlayerProfileInput = z.infer<typeof UpdatePlayerProfileInputSchema>;
