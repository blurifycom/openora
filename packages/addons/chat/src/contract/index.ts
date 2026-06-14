import { oc, eventIterator } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema } from '@oss/shared-schemas';

export const ChatRoomSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  isPublic: z.boolean(),
  createdAt: z.string(),
});

export const ChatMessageSchema = z.object({
  id: z.uuid(),
  roomId: z.uuid().nullable(),
  userId: z.uuid(),
  username: z.string(),
  content: z.string(),
  isDeleted: z.boolean(),
  createdAt: z.string(),
});

// What the client needs to start receiving live messages, tagged by `provider`.
// `.loose()` keeps it an open union so a managed-vendor overlay (eg Ably, which
// adds a `tokenRequest`) can return extra fields without a contract change - the
// vendor-neutral REALTIME_CLIENT_AUTHORIZER seam in @oss/adapters owns the shape.
// Default first-party value: { provider: 'sse', streamPath: '/chat/stream' }.
export const ChatConnectionGrantSchema = z
  .object({
    provider: z.string(),
    channels: z.array(z.string()),
  })
  .loose();

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

  // Mint a connection grant for the authenticated caller so the client knows how
  // to receive live messages. Default (first-party) returns an SSE descriptor;
  // an Ably/GetStream overlay returns a per-player, capability-scoped token. The
  // client picks a transport off `grant.provider` (see @oss/react
  // RealtimeClientProvider). `channels` is optional - the server computes the
  // allowed set when omitted (this pass: the global channel).
  getConnection: oc
    .route({ method: 'GET', path: '/chat/connection' })
    .input(z.object({ clientId: z.string().optional(), channels: z.array(z.string()).optional() }))
    .output(ChatConnectionGrantSchema),

  // Live message feed delivered as Server-Sent Events. `roomId: null` streams the
  // global channel; a room id streams that room. The OpenAPIHandler in
  // @oss/api-runtime serves an event-iterator output as SSE; the client consumes
  // it as an async iterable (see @oss/react useChatStream). Backed by the
  // REALTIME_TRANSPORT seam - first-party in-process by default, swappable to a
  // managed vendor (Ably/GetStream) downstream. See ADR-0007.
  streamMessages: oc
    .route({ method: 'GET', path: '/chat/stream' })
    .input(z.object({ roomId: z.uuid().nullable() }))
    .output(eventIterator(ChatMessageSchema)),
};
