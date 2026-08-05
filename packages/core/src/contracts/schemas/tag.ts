import z from 'zod';
import { MoneyAmountSchema, TimestampSchema, UuidSchema } from './common.js';

export const tagAssignRemoveSource = ['scheduled', 'manual'] as const;
const tagAssignRemoveSourceSchema = z.enum(tagAssignRemoveSource);
export type TagAssignSource = z.infer<typeof tagAssignRemoveSourceSchema>;

export const tagKeys = [
  'high_roller',
  'vip',
  'bonus_abuser',
  'high_risk',
  'inactive',
  'large_depositor',
  'self_excluded',
  'kyc_pending',
  'kyc_rejected',
  'basic_kyc_needed',
  'advanced_kyc_needed',
  'test_account',
  'dormant_high_roller',
  'withdrawal_review',
  'multi_account',
  'level',
] as const;
export const TagKeySchema = z.enum(tagKeys);
export type TagKey = z.infer<typeof TagKeySchema>;

export const tagSchema = z.object({
  id: UuidSchema,
  key: TagKeySchema,
  isSticky: z.boolean().default(false),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Tag = z.infer<typeof tagSchema>;

export const createTagSchema = tagSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = tagSchema.omit({ id: true, createdAt: true, updatedAt: true });
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const deleteTagSchema = tagSchema.pick({ key: true });
export type DeleteTagInput = z.infer<typeof deleteTagSchema>;

export const playerTagSchema = z.object({
  id: UuidSchema,
  playerId: UuidSchema,
  tagId: UuidSchema,
  assignReason: z.string(),
  assignActor: tagAssignRemoveSourceSchema,
  assignActorUserId: UuidSchema.nullable(),
  assignMetadata: z.record(z.string(), z.unknown()).nullable(),
  removedAt: z.coerce.date().nullable(),
  removalReason: z.string().nullable(),
  removalActor: tagAssignRemoveSourceSchema.nullable(),
  removalActorUserId: UuidSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type PlayerTag = z.infer<typeof playerTagSchema>;

export const assignPlayerTagSchema = playerTagSchema
  .pick({ playerId: true, assignActor: true, assignActorUserId: true })
  .extend({
    tagKey: TagKeySchema,
    assignReason: z.string().min(5),
  });
export type AssignPlayerTagInput = z.infer<typeof assignPlayerTagSchema>;

export const removePlayerTagSchema = playerTagSchema.pick({ playerId: true }).extend({
  tagKey: TagKeySchema,
  removalReason: z.string().trim().min(5).optional(),
  removalActor: tagAssignRemoveSourceSchema,
  removalActorUserId: UuidSchema.nullable(),
});
export type RemovePlayerTagInput = z.infer<typeof removePlayerTagSchema>;

// Atomic same-key swap (the mutable `level` tag): one actor performs both halves,
// so the assign actor fields double as the removal actor fields.
export const replacePlayerTagSchema = assignPlayerTagSchema.extend({
  removalReason: z.string().trim().min(5),
});
export type ReplacePlayerTagInput = z.infer<typeof replacePlayerTagSchema>;

export const tagRuleSchema = z.object({
  id: UuidSchema,
  tagId: UuidSchema,
  tagKey: TagKeySchema,
  isEnabled: z.boolean(),
  /** Amount threshold as a decimal string - same unit as wallet.balance and wallet_transaction.amount (high_roller: lifetime deposits; large_depositor: single deposit; high_risk: single withdrawal). */
  threshold: MoneyAmountSchema.nullable(),
  /** Inactivity or rolling-window length in days (inactive, high_risk). */
  thresholdDays: z.number().int().nullable(),
  /** Minimum event count within the window (high_risk withdrawal frequency). */
  thresholdCount: z.number().int().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type TagRule = z.infer<typeof tagRuleSchema>;

export const upsertTagRuleSchema = tagRuleSchema.omit({
  id: true,
  tagId: true,
  createdAt: true,
  updatedAt: true,
});
export type UpsertTagRuleInput = z.infer<typeof upsertTagRuleSchema>;
