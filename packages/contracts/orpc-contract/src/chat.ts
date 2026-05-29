import { oc, eventIterator } from '@orpc/contract';
import * as z from 'zod';

export const ChatRoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  isPublic: z.boolean(),
  createdAt: z.string(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  roomId: z.string().nullable(),
  userId: z.string(),
  username: z.string(),
  content: z.string(),
  isDeleted: z.boolean(),
  createdAt: z.string(),
});

export const chatContract = {
  listRooms: oc.route({ method: 'GET', path: '/chat/rooms' }).output(z.array(ChatRoomSchema)),

  getRoomMessages: oc
    .route({ method: 'GET', path: '/chat/rooms/{roomId}/messages' })
    .input(
      z.object({
        roomId: z.string(),
        limit: z.number().optional(),
        before: z.string().optional(),
      }),
    )
    .output(z.array(ChatMessageSchema)),

  sendRoomMessage: oc
    .route({ method: 'POST', path: '/chat/rooms/{roomId}/messages' })
    .input(z.object({ roomId: z.string(), content: z.string() }))
    .output(ChatMessageSchema),

  deleteMessage: oc
    .route({ method: 'DELETE', path: '/chat/messages/{id}' })
    .input(z.object({ id: z.string() }))
    .output(z.object({ success: z.literal(true) })),

  getGlobalMessages: oc
    .route({ method: 'GET', path: '/chat/global' })
    .output(z.array(ChatMessageSchema)),

  sendGlobalMessage: oc
    .route({ method: 'POST', path: '/chat/global' })
    .input(z.object({ content: z.string() }))
    .output(ChatMessageSchema),

  // Live message feed delivered as Server-Sent Events. `roomId: null` streams the
  // global channel; a room id streams that room. The OpenAPIHandler in
  // @oss/api-runtime serves an event-iterator output as SSE; the client consumes
  // it as an async iterable (see @oss/react-hooks useChatStream). Backed by the
  // REALTIME_TRANSPORT seam - first-party in-process by default, swappable to a
  // managed vendor (Ably/GetStream) downstream. See ADR-0007.
  streamMessages: oc
    .route({ method: 'GET', path: '/chat/stream' })
    .input(z.object({ roomId: z.string().nullable() }))
    .output(eventIterator(ChatMessageSchema)),
};
