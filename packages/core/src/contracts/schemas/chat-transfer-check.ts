import * as z from 'zod';
import { UuidSchema } from './common.js';
import { CommandConfigSchema } from './chat-command.js';
import { ChatContextSendPolicyReasonSchema } from './chat-context-room.js';

/** The chat commands that move money; each one's `chat_command_config` row can switch it off. */
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

/**
 * The local binding takes two shared advisory locks per counterpart in one transaction, so the
 * list is bounded well under Postgres' lock table. A rain asks for at most its own recipient count.
 */
export const CHAT_TRANSFER_MAX_COUNTERPARTS = 500;

export const ChatTransferCheckInputSchema = z.object({
  actorId: UuidSchema,
  /** `null` addresses the global room. */
  roomId: UuidSchema.nullable(),
  counterpartIds: z.array(UuidSchema).max(CHAT_TRANSFER_MAX_COUNTERPARTS),
  command: ChatTransferCommandSchema,
});
export type ChatTransferCheckInput = z.infer<typeof ChatTransferCheckInputSchema>;

export const ChatTransferVerdictSchema = z.discriminatedUnion('allowed', [
  z.object({
    allowed: z.literal(true),
    /** The room the transfer's card goes to: `null` for the global room under either id. */
    canonicalRoomId: UuidSchema.nullable(),
    /** Set for a context room, so the caller can apply its own rule per context. */
    contextRef: z.string().nullable(),
    /** Counterparts in an active block with the actor, either direction. */
    blockedIds: z.array(UuidSchema),
    commandConfig: CommandConfigSchema,
  }),
  z.object({
    allowed: z.literal(false),
    refusal: ChatTransferRefusalSchema,
    /** The context send policy's own code, on `context_send_denied` only. */
    policyReason: ChatContextSendPolicyReasonSchema.optional(),
    /** The room's context, on `context_send_denied` only, so the caller applies its own rule first. */
    contextRef: z.string().optional(),
  }),
]);
export type ChatTransferVerdict = z.infer<typeof ChatTransferVerdictSchema>;
