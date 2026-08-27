---
'@openora/core': minor
---

Let a private-room owner grant and revoke the chat `moderator` role. `chat.setMemberRole`
(`POST /chat/rooms/{roomId}/members/{userId}/role`) writes `chat_room_member.role` through
`ChatRoomMembershipService.setMemberRole`, which was previously unreachable: the role column
and the whole moderation authorization matrix already existed, but nothing could set it.

Granting is owner-only on purpose - a moderator must not be able to create peers - and `owner`
is not assignable here, so ownership transfer stays a separate flow. The write takes the same
`chat-room:{roomId}` advisory lock `leaveRoom` uses, so it serializes against the
last-moderator check. Repeating a grant or a revoke is a successful no-op, and revoking the
last moderator is allowed: zero moderators is a valid end state.

A new nullable `chat_room_member.role_assigned_at` records when a role above `member` was
granted and is cleared on revoke, so a later ownership-transfer flow can pick the
longest-serving moderator. Each change emits `chat.room.member.role-changed`, which the audit
module records against the affected member.
