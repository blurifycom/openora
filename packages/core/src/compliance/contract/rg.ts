import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  TimestampSchema,
  LimitTypeSchema,
  LimitPeriodSchema,
  ExclusionKindSchema,
  ExclusionStatusSchema,
  RgFlagTypeSchema,
  RgFlagStatusSchema,
  MoneyAmountSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, paginated } from '@openora/core/contracts/kit';
import { LimitSchema, isConsistentLimit, isConsistentLimitAmount } from './limits.js';

export const RgExclusionSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  kind: ExclusionKindSchema,
  status: ExclusionStatusSchema,
  reason: z.string(),
  isPermanent: z.boolean(),
  startsAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  liftedAt: TimestampSchema.nullable(),
  liftedReason: z.string().nullable(),
  liftedBy: UuidSchema.nullable(),
  createdBy: UuidSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type RgExclusion = z.infer<typeof RgExclusionSchema>;

export const SetPlayerLimitInputSchema = z
  .object({
    userId: UuidSchema,
    type: LimitTypeSchema,
    amount: MoneyAmountSchema.nullable(),
    minutes: z.number().int().positive().nullable(),
    period: LimitPeriodSchema,
  })
  .refine(isConsistentLimit, {
    message: "type 'session' requires period 'session' and vice versa",
    path: ['period'],
  })
  .refine(isConsistentLimitAmount, {
    message: "type 'session' requires minutes (not amount); other types require amount",
    path: ['amount'],
  });
export type SetPlayerLimitInput = z.infer<typeof SetPlayerLimitInputSchema>;

// 24h .. 6 weeks (1008h) per the Confluence cooling-off window.
export const ActivateCoolingOffInputSchema = z.object({
  userId: UuidSchema,
  durationHours: z.number().int().min(24).max(1008),
  reason: z.string().trim().min(1),
});
export type ActivateCoolingOffInput = z.infer<typeof ActivateCoolingOffInputSchema>;

// Self-exclusion is permanent, OR a fixed term of at least 6 months. `confirm` guards
// against an accidental irreversible action.
export const ActivateSelfExclusionInputSchema = z
  .object({
    userId: UuidSchema,
    isPermanent: z.boolean(),
    durationMonths: z.number().int().min(6).optional(),
    reason: z.string().trim().min(1),
    confirm: z.literal(true),
  })
  .refine((v) => v.isPermanent || v.durationMonths !== undefined, {
    message: 'durationMonths (>= 6) is required unless isPermanent is true',
    path: ['durationMonths'],
  });
export type ActivateSelfExclusionInput = z.infer<typeof ActivateSelfExclusionInputSchema>;

export const LiftSelfExclusionInputSchema = z.object({
  userId: UuidSchema,
  reason: z.string().trim().min(1),
  confirm: z.literal(true),
});
export type LiftSelfExclusionInput = z.infer<typeof LiftSelfExclusionInputSchema>;

export const RgSectionSchema = z.object({
  limits: z.array(LimitSchema),
  coolingOff: RgExclusionSchema.nullable(),
  selfExclusion: RgExclusionSchema.nullable(),
});
export type RgSection = z.infer<typeof RgSectionSchema>;

// Each flagType writes one known detail shape (see rg-monitoring.service.ts).
export const LimitThresholdDetailSchema = z.object({
  actual: MoneyAmountSchema,
  limit: MoneyAmountSchema,
  period: LimitPeriodSchema,
  pct: z.number(),
});
export const SessionTimeDetailSchema = z.object({
  sessionMinutes: z.number(),
  limitMinutes: z.number(),
  pct: z.number(),
});
export const SelfExcludedLoginDetailSchema = z.object({
  trigger: z.string(),
  kind: ExclusionKindSchema.nullable(),
});
export const RgFlagDetailSchema = z.union([
  LimitThresholdDetailSchema,
  SessionTimeDetailSchema,
  SelfExcludedLoginDetailSchema,
]);
export type RgFlagDetail = z.infer<typeof RgFlagDetailSchema>;

export const RgFlagListItemSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  username: z.string().nullable(),
  email: z.string().nullable(),
  flagType: RgFlagTypeSchema,
  limitType: z.string().nullable(),
  // ponytail: tolerate a legacy/empty ('{}') detail on read so one malformed row can't
  // 500 the whole RG dashboard. Writes stay strict via RgFlagDetailSchema (raiseFlag).
  detail: RgFlagDetailSchema.or(z.record(z.string(), z.unknown())),
  status: RgFlagStatusSchema,
  flaggedAt: TimestampSchema,
  clearedAt: TimestampSchema.nullable(),
});
export type RgFlagListItem = z.infer<typeof RgFlagListItemSchema>;

export const ListRgFlagsInputSchema = PageQuerySchema.extend({
  flagType: RgFlagTypeSchema.optional(),
  limitType: LimitTypeSchema.optional(),
  status: RgFlagStatusSchema.optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});
export type ListRgFlagsInput = z.infer<typeof ListRgFlagsInputSchema>;

export const rgContract = {
  setPlayerLimit: oc
    .route({ method: 'PUT', path: '/compliance/players/{userId}/limits' })
    .input(SetPlayerLimitInputSchema)
    .output(LimitSchema),

  activateCoolingOff: oc
    .route({ method: 'POST', path: '/compliance/players/{userId}/cooling-off' })
    .input(ActivateCoolingOffInputSchema)
    .output(RgExclusionSchema),

  activateSelfExclusion: oc
    .route({ method: 'POST', path: '/compliance/players/{userId}/self-exclusion' })
    .input(ActivateSelfExclusionInputSchema)
    .output(RgExclusionSchema),

  liftSelfExclusion: oc
    .route({ method: 'POST', path: '/compliance/players/{userId}/self-exclusion/lift' })
    .input(LiftSelfExclusionInputSchema)
    .output(RgExclusionSchema),

  getRgSection: oc
    .route({ method: 'GET', path: '/compliance/players/{userId}/rg' })
    .input(z.object({ userId: UuidSchema }))
    .output(RgSectionSchema),

  listRgFlags: oc
    .route({ method: 'GET', path: '/compliance/rg-flags' })
    .input(ListRgFlagsInputSchema)
    .output(paginated(RgFlagListItemSchema)),
};
