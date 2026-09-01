---
'@openora/core': minor
---

A private chat room now survives its owner's account being closed: ownership passes to a moderator, or the room enters a 30-day countdown and is then permanently deleted.

- `PlayerService.remove` emits the new `player.account.closed` domain event (it previously changed a player's status silently, leaving nothing for another module to react to). The chat module subscribes to it and to `identity.user.deactivated`, routing both into one idempotent handler.
- `ChatRoomMembershipService.handleAccountClosed` marks the closed account's member row (`chat_room_member.account_closed_at`), and when that row was the owner's, hands the room to the moderator with the earliest `roleAssignedAt` - moving `chatRoom.creatorId` and the member role together, since ownership is read through both. Moderators whose own account is closed are never chosen as successors.
- With no moderator to inherit it, the room keeps `creatorId = null` and gets `chat_room.scheduled_deletion_at` 30 days out. The room stays readable and writable for its members; nobody can rename or delete it, and the deadline is written once and never rewritten, so member activity cannot move it.
- A new `chat-room-purge` job (daily cron, `JOB_QUEUE`) hard-deletes rooms past their deadline along with their messages, bans and mutes. It is the only hard delete in the chat domain and is guarded on the room being private with a deadline that has passed; the `chat.private_room.purged` audit record is the room's only surviving trace.
- `ChatRoomSchema` gains `scheduledDeletionAt`; `ChatRoomMemberSchema` and `ChatRoomUserSchema` gain `isDeletedAccount`, so a client can render a closed account as "Deleted user" without losing the author names on that member's message history.
- New domain events `chat.room.ownership.transferred`, `chat.room.scheduled_for_deletion` and `chat.private_room.purged`, all audited; new `NOTIFICATION_TYPES` `chat.room.ownership_transferred` and `chat.room.scheduled_for_deletion`, delivered in-app to the inheriting owner and to every member of a room on the countdown.
- New realtime signal `chat:room-scheduled-for-deletion` on the room channel, so the countdown banner appears without a reload.
