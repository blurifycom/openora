-- Legacy private-room slugs embedded the join code, making the credential observable.
-- Keep the join code intact so existing invitations continue to work; rotate only the
-- matching slug to a separate, URL-safe UUID identifier.
UPDATE "chat_room"
SET "slug" = 'private-' || gen_random_uuid()::text
WHERE "join_code" IS NOT NULL
  AND "is_public" = false
  AND "slug" = 'private-' || lower("join_code");
