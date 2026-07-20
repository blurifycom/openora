-- Normalize rows written while private chats had a separate category. Cast to
-- text so this remains safe on databases where the enum value was never added.
UPDATE "chat_room"
SET "category" = 'private-channels'::"chat_room_category"
WHERE "category"::text = 'private-chats';
