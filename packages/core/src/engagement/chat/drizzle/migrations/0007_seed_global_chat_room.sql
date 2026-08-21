-- The `__global` room is a system invariant every deployment needs: without it,
-- `/chat/connection` never grants the `chat:global` realtime capability, presence.enter()
-- is rejected, and the online count silently stays 0. ON CONFLICT makes this safe to
-- apply even if a room with this slug was already created out-of-band (eg by the demo seed).
INSERT INTO "chat_room" (name, slug, is_public)
VALUES ('Global', '__global', true)
ON CONFLICT ("slug") DO NOTHING;
