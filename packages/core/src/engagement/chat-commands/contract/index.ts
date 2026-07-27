import { oc } from '@orpc/contract';
import * as z from 'zod';
import { UuidSchema, MoneyAmountSchema, SystemChatMessageSchema } from '@openora/core/contracts';

export const CHAT_COMMAND_TYPES = ['mention', 'profile', 'gift', 'rain'] as const;
export const ChatCommandTypeSchema = z.enum(CHAT_COMMAND_TYPES);
export type ChatCommandType = z.infer<typeof ChatCommandTypeSchema>;

export const CommandConfigSchema = z.object({
  maxAmount: MoneyAmountSchema.optional(),
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
          type: z.literal('profile'),
          targetUsername: z.string().min(1),
          roomId: UuidSchema.nullable(),
        }),
        z.object({
          type: z.literal('gift'),
          targetUsername: z.string().min(1),
          amount: MoneyAmountSchema,
          roomId: UuidSchema.nullable(),
        }),
        z.object({
          type: z.literal('rain'),
          amount: MoneyAmountSchema,
          roomId: UuidSchema,
        }),
      ]),
    )
    .output(SystemChatMessageSchema),

  mentionSearch: oc
    .route({ method: 'GET', path: '/chat-command/mention-search' })
    .input(
      z.object({
        q: z.string().min(1).max(50),
        limit: z.coerce.number().int().min(1).max(20).default(10),
      }),
    )
    .output(z.array(MentionResultSchema)),

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
