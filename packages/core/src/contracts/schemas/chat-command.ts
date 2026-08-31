import * as z from 'zod';
import { CurrencyTickerInputSchema, MoneyAmountSchema, UuidSchema } from './common.js';
import {
  ProfileCommandMetadataSchema,
  GiftCommandMetadataSchema,
  RainCommandMetadataSchema,
  BlockCommandMetadataSchema,
  UnblockCommandMetadataSchema,
  IgnoreCommandMetadataSchema,
  UnignoreCommandMetadataSchema,
  DonateCommandMetadataSchema,
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

/** A system-authored chat message carrying structured command metadata. */
export const CommandChatMessageSchema = SystemChatMessageSchema;
export type CommandChatMessage = SystemChatMessage;

/**
 * Client-facing sentinel for global chat wherever a chat command's `roomId`
 * field is otherwise a real room UUID (`/gift`, `/rain`, `/donate`) - the
 * single canonical way to address global chat on the wire, so callers never
 * send a raw `null`.
 */
export const GLOBAL_CHAT_ROOM_ID = '__global';

export const ChatRoomIdSchema = z
  .union([UuidSchema, z.literal(GLOBAL_CHAT_ROOM_ID)])
  .transform((value) => (value === GLOBAL_CHAT_ROOM_ID ? null : value));
export type ChatRoomIdInput = z.input<typeof ChatRoomIdSchema>;

/**
 * Shared wire input for every money-moving chat command (`/gift`, `/rain`, `/donate`);
 * each command's own schema extends this with only its delta. Omit `currency` and the
 * debit falls on the sender's active currency (unchanged, pre-existing behaviour); when
 * supplied, the recipient is credited in this SAME currency - no conversion ever happens
 * on any of these paths.
 */
export const ChatMoneyCommandInputSchema = z.object({
  amount: MoneyAmountSchema,
  currency: CurrencyTickerInputSchema.optional(),
  roomId: ChatRoomIdSchema,
  idempotencyKey: UuidSchema,
});

/** Canonical chat channel name used by both the chat and chat-commands modules. */
export function chatChannel(roomId: string | null): string {
  return roomId ? `chat:room:${roomId}` : 'chat:global';
}
