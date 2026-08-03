import * as z from 'zod';
import { UuidSchema } from './common.js';
import {
  ProfileCommandMetadataSchema,
  GiftCommandMetadataSchema,
  RainCommandMetadataSchema,
  BlockCommandMetadataSchema,
  IgnoreCommandMetadataSchema,
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
  IgnoreCommandMetadataSchema,
  DonateCommandMetadataSchema,
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
