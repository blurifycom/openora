import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  MoneyAmountSchema,
  SystemChatMessageSchema,
  CommandChatMessageSchema,
  ChatRoomIdSchema,
  TimestampSchema,
  CurrencyTickerSchema,
  ChatMoneyCommandInputSchema,
} from '@openora/core/contracts';
import { PageQuerySchema, SortOrderSchema, paginated } from '@openora/core/contracts/kit';

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

// Keyed by currency ticker, not a single flat amount: a minimum sensible in USD ('1.00') is
// either meaningless or absurd in BTC (18-decimal-scale storage, but real value per unit),
// so one constant across every currency cannot be correct for both. A currency with no entry
// has no limit enforced for it - an operator opts a currency INTO a limit, never gets one by
// accident from a value meant for a different currency.
const PerCurrencyAmountSchema = z.record(CurrencyTickerSchema, MoneyAmountSchema);

export const CommandConfigSchema = z.object({
  maxAmount: PerCurrencyAmountSchema.optional(),
  minAmount: PerCurrencyAmountSchema.optional(),
  maxRecipients: z.number().int().positive().optional(),
});
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

export const ChatCommandDescriptorSchema = z.object({
  key: ChatCommandTypeSchema,
  enabled: z.boolean(),
  label: z.string(),
  description: z.string().nullable(),
  config: CommandConfigSchema.nullable(),
  updatedAt: TimestampSchema,
});
export type ChatCommandDescriptor = z.infer<typeof ChatCommandDescriptorSchema>;

export const AdminCommandSortByValues = ['key', 'updatedAt'] as const;
export const AdminCommandSortBySchema = z.enum(AdminCommandSortByValues).default('key');
export type AdminCommandSortBy = z.infer<typeof AdminCommandSortBySchema>;

export const MentionResultSchema = z.object({
  userId: UuidSchema,
  username: z.string(),
});
export type MentionResult = z.infer<typeof MentionResultSchema>;

export { SystemChatMessageSchema, CommandChatMessageSchema };

export const PostGiftInputSchema = ChatMoneyCommandInputSchema;
export type PostGiftInput = z.infer<typeof PostGiftInputSchema>;

export const PostRainInputSchema = ChatMoneyCommandInputSchema.extend({
  recipientCount: z.number().int().positive(),
});
export type PostRainInput = z.infer<typeof PostRainInputSchema>;

export const ClaimGiftOutputSchema = z.object({
  claimedBy: UuidSchema,
  claimedByUsername: z.string(),
  claimedAt: z.string(),
});
export type ClaimGiftOutput = z.infer<typeof ClaimGiftOutputSchema>;

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
    .output(CommandChatMessageSchema),

  claimGift: oc
    .route({ method: 'POST', path: '/chat-command/gift/{id}/claim' })
    .input(z.object({ id: UuidSchema }))
    .output(ClaimGiftOutputSchema),

  getGift: oc
    .route({ method: 'GET', path: '/chat-command/gift/{id}' })
    .input(z.object({ id: UuidSchema }))
    .output(GiftStateSchema),

  // Dedicated rain-send operation - this module resolves the online recipient
  // list (it owns presence lookups for the chat command surface) and hands it
  // to the RAIN_COMMANDS port; money/limit/idempotency logic lives in
  // social-transfers. See AGENTS.md.
  postRain: oc
    .route({ method: 'POST', path: '/chat-command/rain' })
    .input(PostRainInputSchema)
    .output(CommandChatMessageSchema),

  mentionSearch: oc
    .route({ method: 'GET', path: '/chat-command/mention-search' })
    .input(
      z.object({
        q: z.string().trim().max(50),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        roomId: ChatRoomIdSchema,
      }),
    )
    .output(z.array(MentionResultSchema)),

  adminListCommands: oc
    .route({ method: 'GET', path: '/backoffice/chat-command/commands' })
    .input(
      z.object({
        ...PageQuerySchema.shape,
        sortBy: AdminCommandSortBySchema,
        sortOrder: SortOrderSchema.default('asc'),
      }),
    )
    .output(paginated(ChatCommandDescriptorSchema)),

  adminUpdateCommand: oc
    .route({ method: 'PATCH', path: '/backoffice/chat-command/commands/{key}' })
    .input(
      z.object({
        key: ChatCommandTypeSchema,
        enabled: z.boolean(),
        config: CommandConfigSchema.optional(),
      }),
    )
    .output(ChatCommandDescriptorSchema),
};
