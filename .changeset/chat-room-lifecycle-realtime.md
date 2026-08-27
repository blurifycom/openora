---
'@openora/core': minor
---

Fix four chat defects around private-room lifecycle and realtime.

`chat.leaveRoom` mapped only `ChatRoomLastModeratorError`, so leaving a room that had already
been deleted - or that the caller was never in - surfaced as `INTERNAL_SERVER_ERROR`. Both now
map to `NOT_FOUND` and `FORBIDDEN`, matching how `removeMember` and `getRoom` map theirs.

`deletePrivateRoom` published nothing to the room's realtime channel, leaving members connected
to a room that 404s on every call. It now snapshots the member ids under the same
`chat-room:{roomId}` advisory lock the join/leave paths take and, once the soft-delete commits,
revokes each member from the room channel - the mechanism `removeMember` and a room ban already
use.

`setMemberRole` emitted `chat.room.member.role-changed` on the server-side `EventBus` only, so a
promoted member kept rendering as a plain one until their roster cache happened to expire. It
now also pushes a `chat:member-role-changed` signal on the room channel carrying
`{ roomId, userId, role }` (`CHAT_MEMBER_ROLE_CHANGED_SIGNAL`,
`ChatMemberRoleChangedSignalSchema`).

Carrying that signal adds a named control lane to the realtime seam, in two optional halves so
existing transports, adapters and callers are unaffected. Server side, `RealtimeTransport` gains
`signal(channel, name, payload)`: a named control event, distinct from the channel's payload
stream, the way a managed transport already surfaces `chat:access-revoked`. Client side,
`RealtimeSubscribeHandlers` gains `onSignal(name, payload)`, so a vendor adapter can hand a
signal to the caller without casting through the payload-typed `onMessage` or the connection
enum `onStatus`. `payload` is `unknown` at both ends: the vocabulary of names is open, so the
caller parses the ones it asked for. The first-party in-process transport and the SSE route
carry one payload lane per channel and implement neither half, so an SSE-backed deployment does
not observe signals.

`listRoomUsers` and `listRoomMembers` hid every `admin` / `super-admin` account from a
non-staff viewer, including the admin who created and owns the room - so an admin-owned private
room read as ownerless to every player in it. The member who is the room's `creatorId`, or whose
role is `owner`, is now always returned; staff who are ordinary members stay hidden as before.
