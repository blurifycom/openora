# Chat

Room-based and global messaging. Tables: `chatRoom` (name, slug unique, visibility flag), `chatMessage` (soft-delete via `isDeleted`, indexed by room + createdAt), `chatUserBlock` (directional mute, blocker-keyed).

Routes: `listRooms`, `getRoomMessages`/`sendRoomMessage` (both public for rooms; authenticated senders), `getGlobalMessages`/`sendGlobalMessage` (player-only, global scope), `deleteMessage` (player, ownership-enforced), `getConnection` (issues single-use realtime grant), `streamMessages` (SSE).

Per-viewer block filtering: message list filters out senders the viewer has blocked; blocked player is unaffected (can still send). Filters apply to both room and global streams. Username resolved from header (falls back to 'anonymous'); userId from auth. Realtime push over `REALTIME_TRANSPORT` + per-room grant (server authoritative, never client-supplied).
