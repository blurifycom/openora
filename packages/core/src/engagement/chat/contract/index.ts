import { oc, eventIterator } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema, TimestampSchema, UuidSchema } from '@blurifycom/core/contracts';

export const MAX_MESSAGE_LENGTH = 500;

export const MessageContentSchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

export const ChatRoomSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  slug: z.string(),
  isPublic: z.boolean(),
  createdAt: TimestampSchema,
});
export type ChatRoom = z.infer<typeof ChatRoomSchema>;

export const ChatMessageSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema.nullable(),
  userId: UuidSchema,
  username: z.string(),
  // UNTRUSTED user text. Profanity-gated and dangerous-URL-defanged server-side
  // (best-effort), but NOT HTML-escaped. Consumers MUST render it as text or
  // HTML-escape it - never inject it as raw HTML. See moderation/sanitize-urls.ts.
  content: z.string(),
  isDeleted: z.boolean(),
  createdAt: TimestampSchema,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const BlockedUserSchema = z.object({
  blockedId: UuidSchema,
  createdAt: TimestampSchema,
});

// `.loose()` keeps this an open union so a managed-vendor overlay (eg Ably) can return extra fields without a contract change.
export const ChatConnectionGrantSchema = z
  .object({
    provider: z.string(),
    channels: z.array(z.string()),
  })
  .loose();

// Default first-party SSE; swappable for a managed vendor (Ably/GetStream) downstream. See ADR-0007.
export const chatContract = {
  listRooms: oc.route({ method: 'GET', path: '/chat/rooms' }).output(z.array(ChatRoomSchema)),

  getRoomMessages: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/messages' })
    .input(
      z.object({
        roomId: UuidSchema,
        // Bounded so a caller cannot request an unbounded page (matches the 50 default).
        limit: z.number().int().min(1).max(100).optional(),
        before: z.string().optional(),
      }),
    )
    .output(z.array(ChatMessageSchema)),

  sendRoomMessage: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/messages' })
    .input(z.object({ roomId: UuidSchema, content: MessageContentSchema }))
    .output(ChatMessageSchema),

  deleteMessage: oc
    .route({ method: 'DELETE', path: '/chat/messages/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),

  getGlobalMessages: oc
    .route({ method: 'GET', path: '/chat/global' })
    .output(z.array(ChatMessageSchema)),

  sendGlobalMessage: oc
    .route({ method: 'POST', path: '/chat/global' })
    .input(z.object({ content: MessageContentSchema }))
    .output(ChatMessageSchema),

  getConnection: oc
    .route({ method: 'GET', path: '/chat/connection' })
    .input(z.object({ clientId: z.string().optional(), channels: z.array(z.string()).optional() }))
    .output(ChatConnectionGrantSchema),

  streamMessages: oc
    .route({ method: 'GET', path: '/chat/stream' })
    .input(z.object({ roomId: UuidSchema.nullable() }))
    .output(eventIterator(ChatMessageSchema)),

  listBlockedUsers: oc
    .route({ method: 'GET', path: '/chat/blocks' })
    .output(z.array(BlockedUserSchema)),

  blockUser: oc
    .route({ method: 'POST', path: '/chat/blocks' })
    .input(z.object({ blockedId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),

  unblockUser: oc
    .route({ method: 'DELETE', path: '/chat/blocks/{blockedId}' })
    .input(z.object({ blockedId: UuidSchema }))
    .output(z.object({ success: z.literal(true) })),
};
