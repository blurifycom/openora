import * as z from 'zod';
import {
  CurrencyTickerInputSchema,
  CurrencyTickerSchema,
  MoneyAmountSchema,
  TimestampSchema,
  UuidSchema,
} from './common.js';
import {
  ProfileCommandMetadataSchema,
  GiftCommandMetadataSchema,
  RainCommandMetadataSchema,
  BlockCommandMetadataSchema,
  UnblockCommandMetadataSchema,
  IgnoreCommandMetadataSchema,
  UnignoreCommandMetadataSchema,
  DonateCommandMetadataSchema,
  SystemEventMetadataSchema,
} from './chat-command-metadata.js';

export const CHAT_MESSAGE_TYPES = ['user', 'system'] as const;
export const ChatMessageTypeSchema = z.enum(CHAT_MESSAGE_TYPES);
export type ChatMessageType = z.infer<typeof ChatMessageTypeSchema>;

export const CommandMetadataSchema = z.discriminatedUnion('command', [
  ProfileCommandMetadataSchema,
  GiftCommandMetadataSchema,
  RainCommandMetadataSchema,
  BlockCommandMetadataSchema,
  UnblockCommandMetadataSchema,
  IgnoreCommandMetadataSchema,
  UnignoreCommandMetadataSchema,
  DonateCommandMetadataSchema,
  SystemEventMetadataSchema,
]);
export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;

export const SystemChatMessageSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema.nullable(),
  actorId: UuidSchema,
  userId: UuidSchema,
  username: z.string(),
  content: z.string(),
  type: z.literal('system'),
  metadata: CommandMetadataSchema,
  isDeleted: z.boolean(),
  createdAt: z.string(),
});
export type SystemChatMessage = z.infer<typeof SystemChatMessageSchema>;

/** @alias */
export const CommandChatMessageSchema = SystemChatMessageSchema;
export type CommandChatMessage = SystemChatMessage;

export const GLOBAL_CHAT_ROOM_ID = '__global';

export const CHAT_SYSTEM_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';
export const CHAT_SYSTEM_AUTHOR_USERNAME = 'system';

export const CHAT_SYSTEM_MESSAGE_VERSION = { posted: 1, updated: 2 } as const;

export const CHAT_MODERATION_SCOPES = [GLOBAL_CHAT_ROOM_ID, '__all_public', '__all'] as const;
export const CHAT_MODERATION_SCOPE_VALUES = [...CHAT_MODERATION_SCOPES, 'room'] as const;

export const CHAT_ROOM_REACHES = ['global', 'public', 'private'] as const;
export type ChatRoomReach = (typeof CHAT_ROOM_REACHES)[number];

export const CHAT_SCOPES_COVERING_REACH = {
  global: [GLOBAL_CHAT_ROOM_ID, '__all_public', '__all'],
  public: ['__all_public', '__all'],
  private: ['__all'],
} as const satisfies Record<ChatRoomReach, readonly (typeof CHAT_MODERATION_SCOPES)[number][]>;

export const CHAT_MODERATION_LOOKUP_MAX_USERS = 100;

export const ChatModerationScopeSchema = z.enum(CHAT_MODERATION_SCOPE_VALUES);
export const ChatModerationEntrySchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  roomId: UuidSchema.nullable(),
  scope: ChatModerationScopeSchema,
  reason: z.string(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
});
export const ChatCooldownEntrySchema = ChatModerationEntrySchema.extend({
  cooldownSeconds: z.number().int().positive(),
  createdBy: UuidSchema,
});

export const ChatRoomIdSchema = z
  .union([UuidSchema, z.literal(GLOBAL_CHAT_ROOM_ID)])
  .transform((value) => (value === GLOBAL_CHAT_ROOM_ID ? null : value));
export type ChatRoomIdInput = z.input<typeof ChatRoomIdSchema>;

export const ChatMoneyCommandInputSchema = z.object({
  amount: MoneyAmountSchema,
  currency: CurrencyTickerInputSchema.optional(),
  roomId: ChatRoomIdSchema,
  idempotencyKey: UuidSchema,
});

const CurrencyAmountSchema = z.object({
  currency: CurrencyTickerSchema,
  amount: MoneyAmountSchema,
});

export const CommandConfigSchema = z.object({
  maxAmount: CurrencyAmountSchema.optional(),
  minAmount: CurrencyAmountSchema.optional(),
  maxRecipients: z.number().int().positive().optional(),
});
export type CommandConfig = z.infer<typeof CommandConfigSchema>;

export function chatChannel(roomId: string | null): string {
  return roomId ? `chat:room:${roomId}` : 'chat:global';
}
