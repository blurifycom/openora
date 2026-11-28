import * as z from 'zod';
import { UuidSchema } from './common.js';
import { CommandConfigSchema } from './chat-command.js';
import { ChatContextSendPolicyReasonSchema } from './chat-context-room.js';

export const CHAT_TRANSFER_COMMANDS = ['gift', 'rain', 'donate'] as const;
export const ChatTransferCommandSchema = z.enum(CHAT_TRANSFER_COMMANDS);

export const CHAT_TRANSFER_REFUSALS = [
  'command_disabled',
  'room_not_found',
  'room_access_denied',
  'context_send_denied',
  'chat_unavailable',
] as const;
export const ChatTransferRefusalSchema = z.enum(CHAT_TRANSFER_REFUSALS);
export type ChatTransferRefusal = z.infer<typeof ChatTransferRefusalSchema>;

export const CHAT_TRANSFER_MAX_COUNTERPARTS = 500;

export const ChatTransferCheckInputSchema = z.object({
  actorId: UuidSchema,
  roomId: UuidSchema.nullable(),
  counterpartIds: z.array(UuidSchema).max(CHAT_TRANSFER_MAX_COUNTERPARTS),
  command: ChatTransferCommandSchema,
});
export type ChatTransferCheckInput = z.infer<typeof ChatTransferCheckInputSchema>;

export const ChatTransferVerdictSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    canonicalRoomId: UuidSchema.nullable(),
    contextRef: z.string().nullable(),
    blockedIds: z.array(UuidSchema),
    commandConfig: CommandConfigSchema,
  }),
  z.object({
    allowed: z.literal(false),
    refusal: ChatTransferRefusalSchema,
    policyReason: ChatContextSendPolicyReasonSchema.optional(),
    contextRef: z.string().optional(),
  }),
]);
export type ChatTransferVerdict = z.infer<typeof ChatTransferVerdictSchema>;
