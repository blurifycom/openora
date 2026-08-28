---
'@openora/core': minor
---

Let a private-room owner grant and revoke the chat `moderator` role. `chat.setMemberRole`
(`POST /chat/rooms/{roomId}/members/{userId}/role`) writes `chat_room_member.role` through
`ChatRoomMembershipService.setMemberRole`, which was previously unreachable: the role column
and the whole moderation authorization matrix already existed, but nothing could set it.

The route is private-rooms-only, matching the tier it exists for: an admin-created public room
also carries an owner membership, and that owner is not the person this capability is about.
Granting is owner-only on purpose - a moderator must not be able to create peers - and `owner`
is not assignable here, so ownership transfer stays a separate flow. The write takes the same
`chat-room:{roomId}` advisory lock `leaveRoom` uses, so it serializes against the
last-moderator check, and the update decides whether anything changed, so a member removed
concurrently cannot produce an event for a row that no longer exists. Repeating a grant or a
revoke is a successful no-op, and revoking the last moderator is allowed: zero moderators is a
valid end state.

A new nullable `chat_room_member.role_assigned_at` records when a role above `member` was
granted and is cleared on revoke, so a later ownership-transfer flow can pick the
longest-serving moderator. Rows that already held an elevated role are backfilled from
`joined_at`, so an upgraded database orders its moderators the way a fresh one does rather than
leaving them under the null a plain member uses.

Each change emits `chat.room.member.role-changed` carrying both `previousRole` and `role`,
which the audit module records as before/after against the affected member, attributed to the
acting owner - by playerId, or by the raw acting user id when no player record backs them.
