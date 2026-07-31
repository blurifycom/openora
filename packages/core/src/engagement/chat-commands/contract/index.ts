import { oc } from '@orpc/contract';
import * as z from 'zod';
import { UuidSchema, MoneyAmountSchema, SystemChatMessageSchema } from '@openora/core/contracts';

export const CHAT_COMMAND_TYPES = [
  'mention',
  'profile',
  'gift',
  'rain',
  'donate',
  'block',
  'ignore',
] as const;
export const ChatCommandTypeSchema = z.enum(CHAT_COMMAND_TYPES);
export type ChatCommandType = z.infer<typeof ChatCommandTypeSchema>;

export const CommandConfigSchema = z.object({
  maxAmount: MoneyAmountSchema.optional(),
  minAmount: MoneyAmountSchema.optional(),
  maxRecipients: z.number().int().positive().optional(),
});
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

export const ChatCommandDescriptorSchema = z.object({
  key: ChatCommandTypeSchema,
  enabled: z.boolean(),
  label: z.string(),
  description: z.string().nullable(),
  config: CommandConfigSchema.nullable(),
});
export type ChatCommandDescriptor = z.infer<typeof ChatCommandDescriptorSchema>;

export const MentionResultSchema = z.object({
  userId: UuidSchema,
  username: z.string(),
});
export type MentionResult = z.infer<typeof MentionResultSchema>;

export { SystemChatMessageSchema };

export const GiftStateSchema = z.object({
  id: UuidSchema,
  senderId: UuidSchema,
  senderUsername: z.string(),
  amount: MoneyAmountSchema,
  currency: z.string(),
  claimedBy: UuidSchema.nullable(),
  claimedByUsername: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type GiftState = z.infer<typeof GiftStateSchema>;

export const ClaimGiftOutputSchema = z.object({
  claimedBy: UuidSchema,
  claimedByUsername: z.string(),
  claimedAt: z.string(),
});
export type ClaimGiftOutput = z.infer<typeof ClaimGiftOutputSchema>;

export const PlayerSearchResultSchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
});
export type PlayerSearchResult = z.infer<typeof PlayerSearchResultSchema>;

export const PlayerProfileCardSchema = z.object({
  userId: UuidSchema,
  username: z.string(),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
  joinedAt: z.string(),
  totalWagered: MoneyAmountSchema,
  totalBets: z.number().int(),
  currency: z.string(),
});
export type PlayerProfileCard = z.infer<typeof PlayerProfileCardSchema>;

export const chatCommandsContract = {
  listCommands: oc
    .route({ method: 'GET', path: '/chat-command/commands' })
    .input(z.object({}))
    .output(z.array(ChatCommandDescriptorSchema)),

  execute: oc
    .route({ method: 'POST', path: '/chat-command/execute' })
    .input(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('gift'),
          amount: MoneyAmountSchema,
          roomId: UuidSchema,
          idempotencyKey: UuidSchema,
        }),
        z.object({
          type: z.literal('rain'),
          amount: MoneyAmountSchema,
          recipientCount: z.number().int().positive(),
          roomId: UuidSchema,
          idempotencyKey: UuidSchema,
        }),
        z.object({
          type: z.literal('donate'),
          targetUsername: z.string().min(1),
          amount: MoneyAmountSchema,
          roomId: UuidSchema.nullable(),
          idempotencyKey: UuidSchema,
        }),
        z.object({
          type: z.literal('block'),
          targetUsername: z.string().min(1),
          roomId: UuidSchema.nullable(),
        }),
        z.object({
          type: z.literal('ignore'),
          targetUsername: z.string().min(1),
          roomId: UuidSchema.nullable(),
        }),
      ]),
    )
    .output(SystemChatMessageSchema),

  getGift: oc
    .route({ method: 'GET', path: '/chat-command/gift/{id}' })
    .input(z.object({ id: UuidSchema }))
    .output(GiftStateSchema),

  claimGift: oc
    .route({ method: 'POST', path: '/chat-command/gift/{id}/claim' })
    .input(z.object({ id: UuidSchema }))
    .output(ClaimGiftOutputSchema),

  mentionSearch: oc
    .route({ method: 'GET', path: '/chat-command/mention-search' })
    .input(
      z.object({
        q: z.string().min(1).max(50),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    )
    .output(z.array(MentionResultSchema)),

  playerSearch: oc
    .route({ method: 'GET', path: '/chat-command/player-search' })
    .input(
      z.object({
        q: z.string().min(1).max(50),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    )
    .output(z.array(PlayerSearchResultSchema)),

  playerProfile: oc
    .route({ method: 'GET', path: '/chat-command/player-profile/{userId}' })
    .input(z.object({ userId: UuidSchema }))
    .output(PlayerProfileCardSchema),

  adminUpdateCommand: oc
    .route({ method: 'PATCH', path: '/chat-command/admin/commands/{key}' })
    .input(
      z.object({
        key: ChatCommandTypeSchema,
        enabled: z.boolean(),
        config: CommandConfigSchema.optional(),
      }),
    )
    .output(ChatCommandDescriptorSchema),
};
