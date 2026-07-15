# Chat

Room-based and global messaging. Tables: `chatRoom` (name, slug unique, isPublic flag, joinCode unique nullable for private rooms, creatorId nullable), `chatMessage` (soft-delete via `isDeleted`, indexed by room + createdAt), `chatUserBlock` (directional mute, blocker-keyed), `chatRoomMember` (role: member/moderator, unique per room+user, cascade on room delete), `chatRoomBan` (unique per room+user, cascade on room delete).

Routes (player-facing): `listRooms` (public rooms + private rooms the caller is a member of), `getRoomMessages`/`sendRoomMessage` (public read, authenticated send; private rooms require membership), `getGlobalMessages`/`sendGlobalMessage` (player-only, global scope), `deleteMessage` (player, ownership-enforced), `getConnection` (issues per-player realtime grant covering global + all public rooms + all private rooms where caller is a member), `streamMessages` (SSE, roomId null = global; private room check enforced at router level).

Routes (private room lifecycle): `createPrivateRoom` (player creates room, auto-joined as moderator, join code generated), `joinRoom` (join by code; 404 if invalid, 403 if banned), `leaveRoom` (idempotent), `getRoom` (room detail; joinCode populated for members of private rooms), `kickMember` (moderator removes member - can rejoin), `banMember` (moderator bans member - cannot rejoin even with code; idempotent), `listRoomMembers` (members only for private rooms).

Routes (admin-only, AdminGuard-enforced): `createRoom` (POST /backoffice/chat/rooms - creates public room by slug), `deleteRoom` (DELETE /backoffice/chat/rooms/{id} - cascades messages in tx, members/bans cascade via FK).

Per-viewer block filtering: message list filters out senders the viewer has blocked; blocked player is unaffected (can still send). Filters apply to both room and global streams. Username resolved from the verified user row (falls back to header, then 'anonymous'); userId from auth. Realtime push over `REALTIME_TRANSPORT`.

Access model: public rooms are open to all; private rooms require membership. `verifyRoomAccess(roomId, viewerId?)` is the single authority - called by `getRoomMessages`, `sendRoomMessage`, `getRoom`, `listRoomMembers`, and (via router) `streamMessages`. Moderator check in `kickMember`/`banMember`: caller must have `role = 'moderator'` in `chatRoomMember`.

Audit events: `chat.private_room.created`, `chat.room.member.kicked`, `chat.room.member.banned` are subscribed by the audit module. `chat.user.blocked`/`chat.user.unblocked` also audited. `chat.message.sent` is NOT audited (high-volume).

Join code: 6 chars, 31-char alphabet (no ambiguous 0/1/I/O/L), crypto `randomInt`. Slug for private rooms auto-generated as `private-{joinCode.toLowerCase()}`. Join code is globally unique (DB unique index).

Channel name convention (mirrors `chatChannel()` in the service): `chat:global` for null roomId, `chat:room:{roomId}` for rooms.

Admin role requires `chat-room` resource declared in `server/auth/permissions.ts`.
