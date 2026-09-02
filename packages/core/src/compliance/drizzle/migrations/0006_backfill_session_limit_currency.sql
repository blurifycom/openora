-- 0005 added user_limit.currency nullable. The session-type limit is measured in minutes,
-- not money, so it always carries the SESSION_LIMIT_CURRENCY sentinel (see schema/index.ts):
-- there is no player-currency question for it, and a sentinel rather than NULL keeps the row
-- inside the widened uniqueness check.
--
-- A pre-existing MONEY-type row is deliberately NOT backfilled here. It is resolved to the
-- player's own currency, once, the first time anything touches it (see resolveLimitCurrency
-- in service/rg.service.ts). A blanket backfill would silently redefine a limit the player
-- themselves chose: a 100,000 JPY deposit limit (~$650) rewritten to 100,000 USD is not the
-- same protection. NULL there means "not yet resolved", never "no currency", and it is safe
-- in the widened unique index because the dropped (user_id, type, period) index already
-- allowed at most one such row per slot.
UPDATE "user_limit"
SET "currency" = 'SESSION'
WHERE "type" = 'session' AND "currency" IS NULL;
