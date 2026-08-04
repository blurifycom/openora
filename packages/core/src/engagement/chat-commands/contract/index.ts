import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  MoneyAmountSchema,
  SystemChatMessageSchema,
  ChatRoomIdSchema,
} from '@openora/core/contracts';

export const CHAT_COMMAND_TYPES = [
  'mention',
  'profile',
  'gift',
  'rain',
  'donate',
  'block',
  'unblock',
  'ignore',
  'unignore',
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

export const PostGiftInputSchema = z.object({
  amount: MoneyAmountSchema,
  roomId: ChatRoomIdSchema,
  idempotencyKey: UuidSchema,
});
export type PostGiftInput = z.infer<typeof PostGiftInputSchema>;

export const PostRainInputSchema = z.object({
  amount: MoneyAmountSchema,
  recipientCount: z.number().int().positive(),
  roomId: ChatRoomIdSchema,
  idempotencyKey: UuidSchema,
});
export type PostRainInput = z.infer<typeof PostRainInputSchema>;

export const ClaimGiftOutputSchema = z.object({
  claimedBy: UuidSchema,
  claimedByUsername: z.string(),
  claimedAt: z.string(),
});
export type ClaimGiftOutput = z.infer<typeof ClaimGiftOutputSchema>;

export const chatCommandsContract = {
  listCommands: oc
    .route({ method: 'GET', path: '/chat-command/commands' })
    .input(z.object({}))
    .output(z.array(ChatCommandDescriptorSchema)),

  // Dedicated gift-send operation - money/limit/idempotency logic lives in the
  // social-transfers module behind the GIFT_COMMANDS port; this module only
  // wires the route. See AGENTS.md.
  postGift: oc
    .route({ method: 'POST', path: '/chat-command/gift' })
    .input(PostGiftInputSchema)
    .output(SystemChatMessageSchema),

  claimGift: oc
    .route({ method: 'POST', path: '/chat-command/gift/{id}/claim' })
    .input(z.object({ id: UuidSchema }))
    .output(ClaimGiftOutputSchema),

  // Dedicated rain-send operation - this module resolves the online recipient
  // list (it owns presence lookups for the chat command surface) and hands it
  // to the RAIN_COMMANDS port; money/limit/idempotency logic lives in
  // social-transfers. See AGENTS.md.
  postRain: oc
    .route({ method: 'POST', path: '/chat-command/rain' })
    .input(PostRainInputSchema)
    .output(SystemChatMessageSchema),

  mentionSearch: oc
    .route({ method: 'GET', path: '/chat-command/mention-search' })
    .input(
      z.object({
        q: z.string().min(1).max(50),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    )
    .output(z.array(MentionResultSchema)),
};
