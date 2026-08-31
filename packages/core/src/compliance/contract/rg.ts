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
  CurrencyTickerInputSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';
import { LimitSchema, LimitViewSchema, withLimitConsistencyRefinements } from './limits.js';

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

// Reduce-only (ADR-0036, amended): an admin may create a first limit or lower an
// existing one, effective immediately, but may never raise one the player controls -
// that would be the operator weakening the player's own protection. Enforced
// server-side in RgService.setPlayerLimit, not just here. `reason` is mandatory (every
// override is audited under it) and `confirm` guards the action the same way
// ActivateSelfExclusionInputSchema does.
export const SetPlayerLimitInputSchema = withLimitConsistencyRefinements(
  z.object({
    userId: UuidSchema,
    type: LimitTypeSchema,
    amount: MoneyAmountSchema.nullable(),
    minutes: z.number().int().positive().nullable(),
    currency: CurrencyTickerInputSchema.nullable(),
    period: LimitPeriodSchema,
    reason: z.string().trim().min(1),
    confirm: z.literal(true),
  }),
);
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

export const LiftCoolingOffInputSchema = z.object({
  userId: UuidSchema,
  reason: z.string().trim().min(1),
});
export type LiftCoolingOffInput = z.infer<typeof LiftCoolingOffInputSchema>;

// One shape for both audiences. The admin section carries the pending request too:
// "this player has asked to raise their deposit limit and the cool-down is running" is
// exactly the thing a compliance officer opens this section to see.
export const RgSectionSchema = z.object({
  limits: z.array(LimitViewSchema),
  coolingOff: RgExclusionSchema.nullable(),
  selfExclusion: RgExclusionSchema.nullable(),
});
export type RgSection = z.infer<typeof RgSectionSchema>;

// Player self-service. Every route below acts on the CALLER (`getUserId(context)`) and
// none of them accepts a userId: a player can only ever reach their own RG state.

const PendingChangeTargetSchema = z.object({ id: UuidSchema });

// The three break lengths the player-facing screen offers. The admin route keeps its
// free 24h..1008h range; a self-service button is a fixed choice, not a free number.
export const SELF_SERVICE_BREAK_HOURS = [24, 168, 720] as const;
export const SELF_SERVICE_EXCLUSION_MONTHS = [6, 12, 24, 60] as const;

export const RequestCoolingOffInputSchema = z.object({
  durationHours: z.literal(SELF_SERVICE_BREAK_HOURS),
});
export type RequestCoolingOffInput = z.infer<typeof RequestCoolingOffInputSchema>;

// Fixed terms only, plus permanent. `confirm` is the deliberate second step in front of
// an action nobody can undo - not even support (see RgService.liftSelfExclusion).
export const RequestSelfExclusionInputSchema = z
  .object({
    isPermanent: z.boolean(),
    durationMonths: z.literal(SELF_SERVICE_EXCLUSION_MONTHS).optional(),
    confirm: z.literal(true),
  })
  .refine((v) => v.isPermanent || v.durationMonths !== undefined, {
    message: 'durationMonths is required unless isPermanent is true',
    path: ['durationMonths'],
  });
export type RequestSelfExclusionInput = z.infer<typeof RequestSelfExclusionInputSchema>;

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

export const RG_FLAG_SORT_BY_VALUES = [
  'flaggedAt',
  'limitType',
  'flagType',
  'status',
  'clearedAt',
  'userId',
] as const;
export const RgFlagSortBySchema = z.enum(RG_FLAG_SORT_BY_VALUES).default('flaggedAt');
export type RgFlagSortBy = z.infer<typeof RgFlagSortBySchema>;

export const ListRgFlagsInputSchema = PageQuerySchema.extend({
  flagType: RgFlagTypeSchema.optional(),
  limitType: LimitTypeSchema.optional(),
  status: RgFlagStatusSchema.optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  sortBy: RgFlagSortBySchema.optional(),
  sortOrder: SortOrderSchema.default('desc').optional(),
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

  liftCoolingOff: oc
    .route({ method: 'POST', path: '/compliance/players/{userId}/cooling-off/lift' })
    .input(LiftCoolingOffInputSchema)
    .output(RgExclusionSchema),

  getRgSection: oc
    .route({ method: 'GET', path: '/compliance/players/{userId}/rg' })
    .input(z.object({ userId: UuidSchema }))
    .output(RgSectionSchema),

  listRgFlags: oc
    .route({ method: 'GET', path: '/compliance/rg-flags' })
    .input(ListRgFlagsInputSchema)
    .output(paginated(RgFlagListItemSchema)),

  // One read for the whole player-facing RG screen: limits with their usage, any
  // pending change, and the active exclusions.
  getMyRgSection: oc.route({ method: 'GET', path: '/compliance/rg/me' }).output(RgSectionSchema),

  // Null when the confirmed request was a REMOVAL: the limit is gone, so there is no
  // view left to return.
  confirmPendingLimitChange: oc
    .route({ method: 'POST', path: '/compliance/limits/{id}/pending/confirm' })
    .input(PendingChangeTargetSchema)
    .output(LimitViewSchema.nullable()),

  // Withdrawing a request restores the stricter state, so it never waits on anything.
  cancelPendingLimitChange: oc
    .route({ method: 'DELETE', path: '/compliance/limits/{id}/pending' })
    .input(PendingChangeTargetSchema)
    .output(LimitViewSchema),

  requestCoolingOff: oc
    .route({ method: 'POST', path: '/compliance/rg/cooling-off' })
    .input(RequestCoolingOffInputSchema)
    .output(RgExclusionSchema),

  requestSelfExclusion: oc
    .route({ method: 'POST', path: '/compliance/rg/self-exclusion' })
    .input(RequestSelfExclusionInputSchema)
    .output(RgExclusionSchema),
};
