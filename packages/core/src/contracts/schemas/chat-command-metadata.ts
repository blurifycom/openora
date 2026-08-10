import * as z from 'zod';
import { UuidSchema, MoneyAmountSchema } from './common.js';

export const ProfileCommandMetadataSchema = z.object({
  command: z.literal('profile'),
  targetUserId: UuidSchema,
  displayName: z.string(),
  level: z.number().int(),
});
export type ProfileCommandMetadata = z.infer<typeof ProfileCommandMetadataSchema>;

export const GiftCommandMetadataSchema = z.object({
  command: z.literal('gift'),
  giftId: UuidSchema,
  senderId: UuidSchema,
  senderUsername: z.string(),
  amount: MoneyAmountSchema,
  currency: z.string(),
  // Optional for compatibility with gift messages persisted before claim state
  // was included in command metadata. New gift messages always populate these.
  status: z.enum(['available', 'claimed']).optional(),
  claimedBy: UuidSchema.nullable().optional(),
  claimedByUsername: z.string().nullable().optional(),
  claimedAt: z.string().nullable().optional(),
});
export type GiftCommandMetadata = z.infer<typeof GiftCommandMetadataSchema>;

export const RainCommandMetadataSchema = z.object({
  command: z.literal('rain'),
  fromUserId: UuidSchema,
  fromUsername: z.string().optional(),
  amount: MoneyAmountSchema,
  currency: z.string(),
  recipientCount: z.number().int(),
  perRecipient: MoneyAmountSchema,
  recipients: z
    .array(
      z.object({
        userId: UuidSchema,
        username: z.string(),
      }),
    )
    .optional(),
});
export type RainCommandMetadata = z.infer<typeof RainCommandMetadataSchema>;

export const BlockCommandMetadataSchema = z.object({
  command: z.literal('block'),
  targetUserId: UuidSchema,
  displayName: z.string(),
});
export type BlockCommandMetadata = z.infer<typeof BlockCommandMetadataSchema>;

export const UnblockCommandMetadataSchema = z.object({
  command: z.literal('unblock'),
  targetUserId: UuidSchema,
  displayName: z.string(),
});
export type UnblockCommandMetadata = z.infer<typeof UnblockCommandMetadataSchema>;

export const IgnoreCommandMetadataSchema = z.object({
  command: z.literal('ignore'),
  targetUserId: UuidSchema,
  displayName: z.string(),
});
export type IgnoreCommandMetadata = z.infer<typeof IgnoreCommandMetadataSchema>;

export const UnignoreCommandMetadataSchema = z.object({
  command: z.literal('unignore'),
  targetUserId: UuidSchema,
  displayName: z.string(),
});
export type UnignoreCommandMetadata = z.infer<typeof UnignoreCommandMetadataSchema>;

export const DonateCommandMetadataSchema = z.object({
  command: z.literal('donate'),
  senderId: UuidSchema.optional(),
  senderUsername: z.string().optional(),
  recipientId: UuidSchema,
  recipientUsername: z.string(),
  amount: MoneyAmountSchema,
  currency: z.string(),
});
export type DonateCommandMetadata = z.infer<typeof DonateCommandMetadataSchema>;
