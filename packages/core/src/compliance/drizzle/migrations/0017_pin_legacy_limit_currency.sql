-- ADR-0055. A money limit from before 0005 has no currency; it used to be resolved to the
-- player's currency the first time anything touched it, so a later currency change could still
-- re-denominate an untouched one (100,000 JPY read as 100,000 USD). This touches them all now:
-- each is pinned to the player's current currency, the value a touch would have written, with
-- `updated_at` kept because the limit itself did not change. A row whose player is gone stays
-- NULL and is enforced fail-closed. A row whose slot already holds that currency stays NULL too,
-- rather than break the unique index. `player` belongs to the profile module, which migrates after
-- this one: on a fresh database it does not exist yet and there is nothing to pin. The rows left
-- NULL are counted in a NOTICE; an admin override sets their currency.
DO $$
DECLARE
  unpinned bigint;
BEGIN
  IF to_regclass('player') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $sql$
    UPDATE user_limit AS ul
    SET currency = p.currency
    FROM player AS p
    WHERE p.user_id = ul.user_id
      AND ul.currency IS NULL
      AND ul.amount IS NOT NULL
      AND ul.type <> 'session'
      AND NOT EXISTS (
        SELECT 1 FROM user_limit AS sibling
        WHERE sibling.user_id = ul.user_id
          AND sibling.type = ul.type
          AND sibling.period = ul.period
          AND sibling.currency = p.currency
      )
  $sql$;
  SELECT count(*) INTO unpinned FROM user_limit
  WHERE currency IS NULL AND amount IS NOT NULL AND type <> 'session';
  IF unpinned > 0 THEN
    RAISE NOTICE 'user_limit: % money limits left without a currency refuse every move until an admin override sets one (ADR-0055)', unpinned;
  END IF;
END $$;
--> statement-breakpoint
-- Every user with a limit gets a version row, so the full backfill, which walks this table, reaches
-- each of them, including one whose limits are later removed by a writer that skips the publisher.
INSERT INTO rg_limit_version (user_id, version)
SELECT DISTINCT user_id, 0 FROM user_limit
ON CONFLICT (user_id) DO NOTHING;
