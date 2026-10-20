import * as z from 'zod';
import { TimestampSchema, UuidSchema } from './common.js';

export const CHAT_CONTEXT_REF_MAX_LENGTH = 200;
export const CHAT_CONTEXT_ROOM_NAME_MAX_LENGTH = 100;
export const CHAT_CONTEXT_ROOM_MEMBERS_MAX = 500;

export const ChatContextRefSchema = z
  .string()
  .min(1)
  .max(CHAT_CONTEXT_REF_MAX_LENGTH)
  .refine((ref) => ref === ref.trim(), { message: 'Ref must not start or end with whitespace' });

export const EnsureChatContextRoomInputSchema = z.object({
  ref: ChatContextRefSchema,
  name: z.string().trim().min(1).max(CHAT_CONTEXT_ROOM_NAME_MAX_LENGTH),
  memberIds: z.array(UuidSchema).max(CHAT_CONTEXT_ROOM_MEMBERS_MAX),
});
export type EnsureChatContextRoomInput = z.infer<typeof EnsureChatContextRoomInputSchema>;

export const ChatContextRoomSchema = z.object({
  id: UuidSchema,
  ref: ChatContextRefSchema,
  name: z.string(),
  closed: z.boolean(),
  createdAt: TimestampSchema,
});
export type ChatContextRoom = z.infer<typeof ChatContextRoomSchema>;

export const CHAT_CONTEXT_SEND_POLICY_REASON_MAX_LENGTH = 64;

export const ChatContextSendPolicyReasonSchema = z
  .string()
  .max(CHAT_CONTEXT_SEND_POLICY_REASON_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9_]*$/, { message: 'Reason must be a snake_case code' });

export const ChatContextSendDecisionSchema = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: ChatContextSendPolicyReasonSchema }),
]);
export type ChatContextSendDecision = z.infer<typeof ChatContextSendDecisionSchema>;

export const CHAT_CONTEXT_SEND_DENIED_REASON = 'context_send_denied';

export const ChatContextSendDeniedDataSchema = z.object({
  reason: z.literal(CHAT_CONTEXT_SEND_DENIED_REASON),
  policyReason: ChatContextSendPolicyReasonSchema,
});
export type ChatContextSendDeniedData = z.infer<typeof ChatContextSendDeniedDataSchema>;
