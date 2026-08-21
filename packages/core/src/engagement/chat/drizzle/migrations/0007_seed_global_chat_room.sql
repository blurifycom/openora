-- The `__global` room is a system invariant every deployment needs: without it,
-- `/chat/connection` never grants the `chat:global` realtime capability, presence.enter()
-- is rejected, and the online count silently stays 0. ON CONFLICT makes this safe to
-- re-apply, and also restores the room if it was previously soft-deleted out-of-band
-- (deletedAt would otherwise leave it invisible to getConnection() forever).
INSERT INTO "chat_room" (name, slug, is_public)
VALUES ('Global', '__global', true)
ON CONFLICT ("slug") DO UPDATE SET deleted_at = NULL, is_public = true;
