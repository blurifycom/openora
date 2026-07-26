# Chat

Room-based and global messaging. Global chat is `roomId: null` - no `chatRoom` row, no category. Rooms are public (open to all) or private (`private-channels` category, join-code gated, membership required); rooms and messages soft-delete so history survives moderation.

## Invariants

- `verifyRoomAccess(roomId, viewerId?)` is the SINGLE access authority - every room read, send, stream, and moderation path goes through it, and a deleted room is invisible to all of them.
- Moderation requires `role = 'moderator'` in `chatRoomMember`; a ban blocks rejoin even with a valid code, a kick doesn't. A player may hold up to 15 active private rooms.
- Block filtering is per-viewer: a blocked sender still sends normally, the blocker just stops seeing them (room and global alike).
- Join codes are 6 chars from a 31-char alphabet (no ambiguous `0/1/I/O/L`), crypto `randomInt`, unique at the DB layer. The private-room slug is generated independently (`private-{randomUUID()}`) and must NEVER embed the join code.
- Username comes from the verified user row (falls back to header, then `anonymous`); userId always from auth, never from input.
- `chat.message.sent` is deliberately un-audited (high volume); room/member/block lifecycle events are.

## Realtime

Default bindings are `InProcessRealtimeTransport` + `SseClientAuthorizer`: the browser reads the first-party SSE stream authorized by its session cookie, so fan-out and presence are limited to ONE API process. `extensions/ably/` rebinds `REALTIME_TRANSPORT` + `REALTIME_CLIENT_AUTHORIZER`, but only when `ABLY_API_KEY` AND `ABLY_BROWSER_REALTIME_ENABLED=true` - that explicit flag exists so an API key alone can't disable SSE before the browser adapter is deployed.

Grants from `getConnection` are bound to the authenticated user, scoped to the exact `chat:global` / `chat:room:{id}` channels (mirrors `chatChannel()`), and allow `subscribe` + `presence` only. Never expose `ABLY_API_KEY`, grant the browser `publish`, or let it bypass the Openora message routes - persist and authorize here first, publish after. Delivery is best-effort, never the system of record.

Presence follows the stream: opening SSE enters, closing leaves (`getOnlineCount({ roomId })` reads it). Authenticated tabs de-duplicate per user; anonymous global viewers count separately. Any managed adapter must do the same and refresh grants after a membership change.

## Don't

- Add an admin route without the `chat-room` resource declared in `server/auth/permissions.ts`.
