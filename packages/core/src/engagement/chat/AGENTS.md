# Chat

Room-based and global messaging. Tables: `chatRoom` (name, slug unique, required category: games-sports/regions/languages/private-channels, isPublic flag, joinCode unique nullable for private rooms, creatorId nullable, soft-delete via `deletedAt`), `chatMessage` (soft-delete via `isDeleted`, indexed by room + createdAt), `chatUserBlock` (directional mute, blocker-keyed), `chatRoomMember` (role: member/moderator, unique per room+user), `chatRoomBan` (unique per room+user).

Routes (player-facing): `listRooms` (public rooms + private rooms the caller is a member of), `getRoomMessages`/`sendRoomMessage` (public read, authenticated send; private rooms require membership), `getGlobalMessages`/`sendGlobalMessage` (player-only, global scope), `deleteMessage` (player, ownership-enforced), `getConnection` (issues per-player realtime grant covering global + all public rooms + all private rooms where caller is a member), `streamMessages` (SSE, roomId null = global; private room check enforced at router level).

Presence and FE adoption: call `getOnlineCount({ roomId })` to display the current unique online count (`roomId: null` is global chat). Opening the SSE `streamMessages` route enters presence and closing it leaves; authenticated tabs are de-duplicated per user, while anonymous global viewers count separately. A managed realtime adapter (Ably, etc.) must enter and leave presence on the same `chat:global` / `chat:room:{id}` channel for each connection, implement `RealtimePresence.count()` against that provider, and refresh/revoke client grants after a room membership change.

Routes (private room lifecycle): `createPrivateRoom` (player creates up to 15 active private-channels rooms, auto-joined as moderator, join code generated), `joinRoom` (join by code; 404 if invalid, 403 if banned), `leaveRoom` (idempotent), `getRoom` (room detail; joinCode populated for members of private rooms), `kickMember` (moderator removes member - can rejoin), `banMember` (moderator bans member - cannot rejoin even with code; idempotent), `listRoomMembers` (members only for private rooms).

Routes (admin-only, AdminGuard-enforced): `createRoom` (POST /backoffice/chat/rooms - creates public room by slug and required category), `listAdminRooms` (GET /backoffice/chat/rooms - paginated public rooms, sortable by name or creation time), `updateRoom` (PATCH /backoffice/chat/rooms/{id} - changes name, slug, and/or category), `deleteRoom` (DELETE /backoffice/chat/rooms/{id} - soft-deletes the room while preserving messages, memberships, and bans).

Per-viewer block filtering: message list filters out senders the viewer has blocked; blocked player is unaffected (can still send). Filters apply to both room and global streams. Username resolved from the verified user row (falls back to header, then 'anonymous'); userId from auth. Realtime push over `REALTIME_TRANSPORT`.

Access model: public rooms are open to all; private rooms require membership. Deleted rooms are excluded from all room reads, lists, joins, and moderation operations. `verifyRoomAccess(roomId, viewerId?)` is the single authority - called by `getRoomMessages`, `sendRoomMessage`, `getRoom`, `listRoomMembers`, `leaveRoom`, `kickMember`, `banMember`, and (via router) `streamMessages`. Moderator check in `kickMember`/`banMember`: caller must have `role = 'moderator'` in `chatRoomMember`.

Audit events: `chat.private_room.created`, `chat.room.member.kicked`, `chat.room.member.banned` are subscribed by the audit module. `chat.user.blocked`/`chat.user.unblocked` also audited. `chat.message.sent` is NOT audited (high-volume).

Join code: 6 chars, 31-char alphabet (no ambiguous 0/1/I/O/L), crypto `randomInt`. Slug for private rooms auto-generated as `private-{joinCode.toLowerCase()}`. Join code is globally unique (DB unique index).

Channel name convention (mirrors `chatChannel()` in the service): `chat:global` for null roomId, `chat:room:{roomId}` for rooms.

Admin role requires `chat-room` resource declared in `server/auth/permissions.ts`.
