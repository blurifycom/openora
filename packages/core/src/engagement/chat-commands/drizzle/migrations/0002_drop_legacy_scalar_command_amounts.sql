-- Before per-currency amounts, `config.minAmount` / `config.maxAmount` held a bare decimal
-- string ("1.00000000"). They now hold a currency-keyed record, and rows written by the
-- earlier release still carry the scalar, which fails the descriptor contract and takes the
-- whole command list down with it.
--
-- The scalar never recorded which currency it meant, so there is nothing to convert it into:
-- inventing one would write a money limit no operator ever set. Both fields are optional, so
-- the key is dropped and an admin re-sets the limit through the backoffice update route.
UPDATE "chat_command_config"
SET "config" = "config" - 'minAmount'
WHERE jsonb_typeof("config" -> 'minAmount') = 'string';
--> statement-breakpoint
UPDATE "chat_command_config"
SET "config" = "config" - 'maxAmount'
WHERE jsonb_typeof("config" -> 'maxAmount') = 'string';
--> statement-breakpoint
UPDATE "chat_command_config"
SET "config" = NULL
WHERE "config" = '{}'::jsonb;
