---
'@openora/core': minor
---

Fix four chat defects around private-room lifecycle and realtime.

`chat.leaveRoom` mapped only `ChatRoomLastModeratorError`, so leaving a room that had already
been deleted - or that the caller was never in - surfaced as `INTERNAL_SERVER_ERROR`. Both now
map to `NOT_FOUND` and `FORBIDDEN`, matching how `removeMember` and `getRoom` map theirs.

`deletePrivateRoom` published nothing to the room's realtime channel, leaving members connected
to a room that 404s on every call. It now runs its ownership and active-room checks inside the
same `chat-room:{roomId}` advisory lock the join/leave paths take, soft-deletes conditionally on
the room still being active, and only then - once the delete has committed and the deletion
event is out - revokes each member from the room channel, the mechanism `removeMember` and a
room ban already use. Two concurrent deletes therefore produce one deletion and one audit event
rather than two, and a realtime transport that is down can no longer fail, or silently swallow
the audit trail of, a deletion that has already happened.

`setMemberRole` emitted `chat.room.member.role-changed` on the server-side `EventBus` only, so a
promoted member kept rendering as a plain one until their roster cache happened to expire. It
now also pushes a `chat:member-role-changed` signal on the room channel carrying
`{ roomId, userId, role }` (`CHAT_MEMBER_ROLE_CHANGED_SIGNAL`,
`ChatMemberRoleChangedSignalSchema`).

Carrying that signal adds a named control lane to the realtime seam, and the default stack
carries it: `InProcessRealtimeTransport` implements `signal(channel, name, payload)` plus the
new `subscribeSignal(channel, handler, userId)` over a second lane per channel, and the new
`chat.streamSignals` route (`GET /chat/signals`) streams that lane to browsers under the same
access rules as `/chat/stream`. The two lanes never cross: a signal cannot arrive as a
`ChatMessage`, and a message cannot arrive as a signal. Client side,
`RealtimeSubscribeHandlers` gains `onSignal(name, payload)`, so a vendor adapter can hand a
signal to the caller without casting through the payload-typed `onMessage` or the connection
enum `onStatus`. `payload` is `unknown` at both ends: the vocabulary of names is open, so the
caller parses the ones it asked for. Every half stays optional, so an existing transport or
adapter that ignores signals is unaffected. Signalling is best-effort: the role change is
already committed, so a rejecting transport is logged, not returned to the caller.

**Breaking for custom realtime adapters:** `RealtimeTransport.revokeClientFromChannel(clientId,
channel)` is now `revokeUserFromChannel(userId, channel)`, and `subscribe`'s third argument is
named `userId` to match. Every caller in core already passed a user id; the old name invited an
adapter to key revocation on the per-connection `clientId` a caller may choose through
`getConnection`, which would have left the same person's other tabs subscribed after their
access was removed. Rename the method and revoke every connection issued under that user.

`listRoomUsers` and `listRoomMembers` hid every `admin` / `super-admin` account from a
non-staff viewer, including the admin who created and owns the room - so an admin-owned private
room read as ownerless to every player in it. The member who is the room's `creatorId`, or whose
role is `owner`, is now always returned; staff who are ordinary members stay hidden as before.
