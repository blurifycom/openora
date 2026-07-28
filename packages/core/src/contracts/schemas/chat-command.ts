import * as z from 'zod';
import { UuidSchema, MoneyAmountSchema } from './common.js';

export const CHAT_MESSAGE_TYPES = ['user', 'system'] as const;
export const ChatMessageTypeSchema = z.enum(CHAT_MESSAGE_TYPES);
export type ChatMessageType = z.infer<typeof ChatMessageTypeSchema>;

export const CommandMetadataSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('profile'),
    targetUserId: UuidSchema,
    displayName: z.string(),
    level: z.number().int(),
  }),
  z.object({
    command: z.literal('gift'),
    giftId: UuidSchema,
    senderId: UuidSchema,
    senderUsername: z.string(),
    amount: MoneyAmountSchema,
    currency: z.string(),
  }),
  z.object({
    command: z.literal('rain'),
    fromUserId: UuidSchema,
    amount: MoneyAmountSchema,
    currency: z.string(),
    recipientCount: z.number().int(),
    perRecipient: MoneyAmountSchema,
  }),
  z.object({
    command: z.literal('block'),
    targetUserId: UuidSchema,
    displayName: z.string(),
  }),
  z.object({
    command: z.literal('ignore'),
    targetUserId: UuidSchema,
    displayName: z.string(),
  }),
]);
export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;

export const SystemChatMessageSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema.nullable(),
  actorId: UuidSchema,
  content: z.string(),
  metadata: CommandMetadataSchema,
  createdAt: z.string(),
});
export type SystemChatMessage = z.infer<typeof SystemChatMessageSchema>;

/** Canonical chat channel name used by both the chat and chat-commands modules. */
export function chatChannel(roomId: string | null): string {
  return roomId ? `chat:room:${roomId}` : 'chat:global';
}
