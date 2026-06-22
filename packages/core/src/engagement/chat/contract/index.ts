import { oc, eventIterator } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema } from '@blurifycom/core/contracts';

export const ChatRoomSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  isPublic: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const ChatMessageSchema = z.object({
  id: z.uuid(),
  roomId: z.uuid().nullable(),
  userId: z.uuid(),
  username: z.string(),
  content: z.string(),
  isDeleted: z.boolean(),
  createdAt: z.iso.datetime(),
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
        roomId: z.uuid(),
        limit: z.number().optional(),
        before: z.string().optional(),
      }),
    )
    .output(z.array(ChatMessageSchema)),

  sendRoomMessage: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/messages' })
    .input(z.object({ roomId: z.uuid(), content: z.string() }))
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
    .input(z.object({ content: z.string() }))
    .output(ChatMessageSchema),

  getConnection: oc
    .route({ method: 'GET', path: '/chat/connection' })
    .input(z.object({ clientId: z.string().optional(), channels: z.array(z.string()).optional() }))
    .output(ChatConnectionGrantSchema),

  streamMessages: oc
    .route({ method: 'GET', path: '/chat/stream' })
    .input(z.object({ roomId: z.uuid().nullable() }))
    .output(eventIterator(ChatMessageSchema)),
};
