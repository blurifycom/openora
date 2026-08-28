-- 0008 added role_assigned_at nullable, so every row that already carried an elevated role
-- kept NULL - the value the column otherwise reserves for a plain member. Ownership transfer
-- picks the successor by the earliest assignment, so an upgraded database would order its
-- moderators differently from a fresh one. joined_at is the only assignment time those rows
-- ever had: for an owner it is when the room was created, and no pre-0008 deployment could
-- grant `moderator` at all (this release ships the first route that writes the column).
UPDATE "chat_room_member"
SET "role_assigned_at" = "joined_at"
WHERE "role" <> 'member' AND "role_assigned_at" IS NULL;
