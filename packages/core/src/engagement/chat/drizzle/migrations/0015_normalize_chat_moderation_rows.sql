-- Fold row-id bans on the global room into `__global`; per player the longest stays active, the rest are lifted.
-- A lapsed row is lifted at its own expiry so the expiry sweep still records it.
WITH "global_room" AS (
  SELECT "id" FROM "chat_room" WHERE "slug" = '__global'
), "ranked" AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "user_id"
    ORDER BY "expires_at" DESC NULLS FIRST, "created_at" DESC
  ) AS "rank"
  FROM "chat_platform_ban"
  WHERE "lifted_at" IS NULL
    AND (
      ("scope" = '__global' AND "room_id" IS NULL)
      OR ("scope" = 'room' AND "room_id" IN (SELECT "id" FROM "global_room"))
    )
)
UPDATE "chat_platform_ban"
SET "lifted_at" = CASE WHEN "expires_at" <= now() THEN "expires_at" ELSE now() END
WHERE "id" IN (SELECT "id" FROM "ranked" WHERE "rank" > 1);--> statement-breakpoint
UPDATE "chat_platform_ban" SET "scope" = '__global', "room_id" = NULL
WHERE "scope" = 'room'
  AND "room_id" IN (SELECT "id" FROM "chat_room" WHERE "slug" = '__global');--> statement-breakpoint
-- Older `__global` mutes kept the issuing room; they only ever applied in global chat.
UPDATE "chat_mute" SET "room_id" = NULL
WHERE "scope" = '__global' AND "room_id" IS NOT NULL;--> statement-breakpoint
UPDATE "chat_mute" SET "scope" = '__global', "room_id" = NULL
WHERE "scope" = 'room'
  AND "room_id" IN (SELECT "id" FROM "chat_room" WHERE "slug" = '__global');--> statement-breakpoint
-- Keep the longest active mute per player and scope so the next migration's unique index can build.
UPDATE "chat_mute"
SET "lifted_at" = CASE WHEN "expires_at" <= now() THEN "expires_at" ELSE now() END
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "user_id", "scope", "room_id"
      ORDER BY "expires_at" DESC NULLS FIRST, "created_at" DESC
    ) AS "rank"
    FROM "chat_mute"
    WHERE "lifted_at" IS NULL
  ) AS "ranked"
  WHERE "rank" > 1
);--> statement-breakpoint
UPDATE "chat_message" SET "room_id" = NULL
WHERE "room_id" IN (SELECT "id" FROM "chat_room" WHERE "slug" = '__global');
