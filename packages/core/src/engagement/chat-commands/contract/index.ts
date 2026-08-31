import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  UuidSchema,
  MoneyAmountSchema,
  ChatRoomIdSchema,
  TimestampSchema,
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

export const chatCommandsContract = {
  listCommands: oc
    .route({ method: 'GET', path: '/chat-command/commands' })
    .input(z.object({}))
    .output(z.array(ChatCommandDescriptorSchema)),

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
